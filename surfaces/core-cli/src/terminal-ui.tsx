import { Box, type Key, render, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import wrapAnsi from "wrap-ansi";
import { LogBuffer } from "./log-stream.js";
import { CommandCancelledError } from "./operation-errors.js";
import type {
  AtlasCoreOperator,
  DeploymentDetails,
  DeploymentService,
  DeploymentSnapshot,
  DiagnosticsResult,
  InteractiveCLI,
  LifecycleOperation,
  LifecycleOperationOptions,
  LifecycleOperationProgress,
  LogStream,
  PluginActivity,
  PluginActivityReporter,
  PluginDeploymentStatus,
  PluginOperationOutcome,
  PluginUpdatePlan,
  UpdateInfo,
  UpdateProgress,
  UpdateReporter,
  UpdateScope
} from "./operator.js";
import { lifecycleOperationLabel, lifecycleOperationSummary } from "./operator.js";

type Screen =
  | { kind: "busy"; label: string }
  | { kind: "message"; message: string; returnTo?: "menu" | "plugins" | "status" }
  | { kind: "logs" }
  | {
      kind: "log-viewer";
      returnTo: "menu" | "plugins" | "status";
      service: string | undefined;
      services: readonly LogServiceOption[];
      stream: LogStream;
      title: string;
    }
  | { kind: "diagnostics"; view: DiagnosticsResult | Error; returnTo: "menu" | "status" }
  | { kind: "menu"; notice?: Notice; snapshot: DeploymentSnapshot }
  | { kind: "operation"; view: LifecycleOperationView }
  | { error?: string; kind: "password" }
  | { kind: "plugin-activity"; view: PluginActivityView }
  | { kind: "plugin-update-review"; plan: PluginUpdatePlan }
  | { kind: "plugins"; view: PluginDeploymentStatus[] | Error }
  | { kind: "reset-confirmation" }
  | { kind: "status"; view: DeploymentDetails | Error }
  | { kind: "update"; info: UpdateInfo }
  | { kind: "update-error"; message: string }
  | { kind: "update-operation"; view: UpdateOperationView }
  | { kind: "update-review"; info: UpdateInfo; scope: UpdateScope };

type AppMode = "configure" | "menu" | "update";

type OperationResult<T> = {
  cancelled: boolean;
  failure?: Error;
  value?: T;
};

type LifecycleOperationEvent = LifecycleOperationProgress & { elapsedMs: number };

type Notice = {
  message: string;
  tone: "green" | "yellow";
};

type LifecycleOperationView = {
  completedAt?: number;
  error?: string;
  events: LifecycleOperationEvent[];
  operation: LifecycleOperation;
  startedAt: number;
  status: "running" | "cancelling" | "success" | "failure" | "cancelled";
  summary?: string;
  snapshot?: DeploymentSnapshot;
};

type UpdateOperationEvent = UpdateProgress & { elapsedMs: number };

type UpdateOperationView = {
  completedAt?: number;
  error?: string;
  events: UpdateOperationEvent[];
  info: UpdateInfo;
  scope: UpdateScope;
  startedAt: number;
  status: "running" | "cancelling" | "success" | "failure" | "cancelled";
};

type LifecycleRunOptions = LifecycleOperationOptions;

type PluginActivityEvent = PluginActivity & { elapsedMs: number };

type PluginActivityView = {
  action: "Enable" | "Disable" | "Install" | "Replace" | "Update";
  completedAt?: number;
  error?: string;
  events: PluginActivityEvent[];
  operationId: number;
  plugin: PluginDeploymentStatus;
  snapshot?: DeploymentSnapshot;
  targetVersion?: string;
  startedAt: number;
  status: "running" | "cancelling" | "success" | "failure" | "cancelled";
};

type KeyValue = readonly [string, string];
type StatusView = DeploymentDetails | Error;
type LogServiceOption = { id: string | undefined; label: string };

type AtlasCoreAppProps = {
  input: NodeJS.ReadStream;
  mode: AppMode;
  operator: AtlasCoreOperator;
};

const MINIMUM_TERMINAL_COLUMNS = 40;
const MINIMUM_TERMINAL_ROWS = 24;
const MAX_UPDATE_EVENTS = 200;
const MAX_UPDATE_EVENT_MESSAGE_LENGTH = 2_048;
const CORE_UPDATE_REVIEW_COPY =
  "PostgreSQL, MinIO, credentials, and configuration are preserved. Atlas Core returns to its prior running or stopped state after the image pull.";
const STATUS_REFRESH_INTERVAL_MS = 5_000;
const RESET_CONFIRMATION_DESCRIPTION =
  "Containers, PostgreSQL and MinIO data, credentials, and configuration will be deleted. A new deployment will be initialized afterward.";

export function createInteractiveCLI(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout
): InteractiveCLI {
  return {
    configureAdmin: async (operator) => {
      await runInkApp(operator, "configure", input, output);
    },
    runMenu: async (operator) => {
      await runInkApp(operator, "menu", input, output);
    },
    runUpdate: async (operator) => {
      await runInkApp(operator, "update", input, output);
    }
  };
}

async function runInkApp(
  operator: AtlasCoreOperator,
  mode: AppMode,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream
): Promise<void> {
  assertInteractive(input, output);
  const instance = render(<AtlasCoreApp input={input} mode={mode} operator={operator} />, {
    alternateScreen: true,
    exitOnCtrlC: false,
    incrementalRendering: true,
    interactive: true,
    maxFps: 30,
    patchConsole: false,
    stderr: output,
    stdin: input,
    stdout: output
  });
  try {
    await instance.waitUntilExit();
  } finally {
    instance.cleanup();
  }
}

function AtlasCoreApp({ input, mode, operator }: AtlasCoreAppProps): ReactNode {
  const { exit, waitUntilRenderFlush } = useApp();
  const activePluginOperation = useRef<number | undefined>(undefined);
  const activeLifecycleOperation = useRef<number | undefined>(undefined);
  const activeUpdateOperation = useRef<number | undefined>(undefined);
  const lifecycleOperationGeneration = useRef(0);
  const updateOperationGeneration = useRef(0);
  const lifecycleCancellation = useRef<"return" | "exit" | undefined>(undefined);
  const updateCancellation = useRef<"return" | "exit" | undefined>(undefined);
  const pluginCancellationRequested = useRef(false);
  const pluginCancellation = useRef<"return" | "exit" | undefined>(undefined);
  const pluginOperationGeneration = useRef(0);
  const statusAbortController = useRef<AbortController | undefined>(undefined);
  const statusGeneration = useRef(0);
  const statusReadPending = useRef<Promise<StatusView> | undefined>(undefined);
  const terminalLost = useRef(false);
  const terminalLossError = useRef<Error | undefined>(undefined);
  const [screen, setScreen] = useState<Screen>({
    kind: "busy",
    label: initialLoadingLabel(mode)
  });

  const loadMenu = useCallback(
    async (notice?: Notice) => {
      setScreen({ kind: "busy", label: "Checking deployment..." });
      setScreen({ kind: "menu", snapshot: await readSnapshot(operator), ...(notice ? { notice } : {}) });
    },
    [operator]
  );

  const readStatus = useCallback(
    async (fresh: boolean, signal: AbortSignal): Promise<StatusView> => {
      while (statusReadPending.current) {
        const view = await statusReadPending.current;
        if (!fresh) return view;
      }
      const request = operator.details(signal).catch((error: unknown) => new Error(errorMessage(error)));
      statusReadPending.current = request;
      try {
        return await request;
      } finally {
        if (statusReadPending.current === request) statusReadPending.current = undefined;
      }
    },
    [operator]
  );

  const loadStatus = useCallback(async () => {
    statusAbortController.current?.abort();
    const controller = new AbortController();
    statusAbortController.current = controller;
    const generation = statusGeneration.current + 1;
    statusGeneration.current = generation;
    setScreen({ kind: "busy", label: "Loading deployment and Docker statistics..." });
    const view = await readStatus(true, controller.signal);
    if (statusGeneration.current === generation && statusAbortController.current === controller) {
      setScreen({ kind: "status", view });
    }
  }, [readStatus]);

  const refreshStatus = useCallback(async () => {
    const controller = statusAbortController.current;
    if (!controller) return;
    const generation = statusGeneration.current;
    const view = await readStatus(false, controller.signal);
    if (statusGeneration.current === generation && statusAbortController.current === controller) {
      setScreen((current) => (current.kind === "status" ? { kind: "status", view } : current));
    }
  }, [readStatus]);

  const invalidateStatus = useCallback(() => {
    statusGeneration.current += 1;
    statusAbortController.current?.abort();
    statusAbortController.current = undefined;
  }, []);

  const loadUpdate = useCallback(async () => {
    setScreen({ kind: "busy", label: "Checking npm for the latest release..." });
    try {
      setScreen({ kind: "update", info: await operator.checkForUpdates() });
    } catch (error) {
      setScreen({ kind: "update-error", message: errorMessage(error) });
    }
  }, [operator]);

  const loadPlugins = useCallback(async () => {
    setScreen({ kind: "busy", label: "Loading Plugins..." });
    try {
      const statuses = await operator.pluginStatuses();
      const statusesWithPlans: PluginDeploymentStatus[] = [];
      for (const status of statuses) {
        if (status.installed === true && operator.pluginUpdatePlan) {
          try {
            statusesWithPlans.push({ ...status, updatePlan: await operator.pluginUpdatePlan(status.pluginId) });
          } catch (error) {
            statusesWithPlans.push({ ...status, error: status.error ?? errorMessage(error) });
          }
        } else {
          statusesWithPlans.push(status);
        }
      }
      setScreen({ kind: "plugins", view: statusesWithPlans });
    } catch (error) {
      setScreen({ kind: "plugins", view: new Error(errorMessage(error)) });
    }
  }, [operator]);

  useEffect(() => {
    if (mode === "configure") setScreen({ kind: "password" });
    else if (mode === "update") void loadUpdate();
    else void loadMenu();
  }, [loadMenu, loadUpdate, mode]);

  useEffect(() => {
    const onEnd = (): void => {
      terminalLost.current = true;
      operator.cancelPending();
      const error = new Error("Atlas Core lost its terminal input.");
      terminalLossError.current = error;
      if (
        activeLifecycleOperation.current === undefined &&
        activeUpdateOperation.current === undefined &&
        activePluginOperation.current === undefined
      )
        exit(error);
      else {
        if (activeLifecycleOperation.current !== undefined) {
          lifecycleCancellation.current = "exit";
          setScreen((current) =>
            lifecycleCancellationScreen(current, "Terminal input lost. Waiting for safe cleanup.")
          );
        } else if (activeUpdateOperation.current !== undefined) {
          updateCancellation.current = "exit";
          setScreen((current) => updateCancellationScreen(current, "Terminal input lost. Waiting for safe cleanup."));
        } else {
          pluginCancellationRequested.current = true;
          pluginCancellation.current = "exit";
          setScreen((current) =>
            pluginActivityCancellationScreen(current, "Terminal input lost. Waiting for safe cleanup.")
          );
        }
      }
    };
    const onError = (error: Error): void => {
      terminalLost.current = true;
      operator.cancelPending();
      const terminalError = new Error(`Atlas Core lost its terminal input: ${error.message}`);
      terminalLossError.current = terminalError;
      if (
        activeLifecycleOperation.current === undefined &&
        activeUpdateOperation.current === undefined &&
        activePluginOperation.current === undefined
      )
        exit(terminalError);
      else {
        if (activeLifecycleOperation.current !== undefined) {
          lifecycleCancellation.current = "exit";
          setScreen((current) =>
            lifecycleCancellationScreen(current, "Terminal input lost. Waiting for safe cleanup.")
          );
        } else if (activeUpdateOperation.current !== undefined) {
          updateCancellation.current = "exit";
          setScreen((current) => updateCancellationScreen(current, "Terminal input lost. Waiting for safe cleanup."));
        } else {
          pluginCancellationRequested.current = true;
          pluginCancellation.current = "exit";
          setScreen((current) =>
            pluginActivityCancellationScreen(current, "Terminal input lost. Waiting for safe cleanup.")
          );
        }
      }
    };
    input.once("end", onEnd);
    input.once("error", onError);
    return () => {
      input.off("end", onEnd);
      input.off("error", onError);
    };
  }, [exit, input, operator]);

  const runLifecycleOperation = useCallback(
    async (operation: LifecycleOperation, options: LifecycleRunOptions = {}): Promise<void> => {
      const operationId = lifecycleOperationGeneration.current + 1;
      lifecycleOperationGeneration.current = operationId;
      const startedAt = Date.now();
      activeLifecycleOperation.current = operationId;
      lifecycleCancellation.current = undefined;
      terminalLossError.current = undefined;
      setScreen({
        kind: "operation",
        view: {
          events: [],
          operation,
          startedAt,
          status: "running"
        }
      });
      await waitUntilRenderFlush();
      const report = (progress: LifecycleOperationProgress): void => {
        if (activeLifecycleOperation.current !== operationId) return;
        setScreen((current) =>
          current.kind === "operation"
            ? {
                ...current,
                view: {
                  ...current.view,
                  events: [...current.view.events, { ...progress, elapsedMs: Date.now() - startedAt }]
                }
              }
            : current
        );
      };
      const result = await runCancelableOperation(operator, async () => {
        if (Object.keys(options).length > 0) return await operator.runLifecycle(operation, report, options);
        return await operator.runLifecycle(operation, report);
      });
      activeLifecycleOperation.current = undefined;
      const lifecycleResult = result.value;
      const cancelled = result.cancelled || lifecycleResult?.status === "cancelled";
      if (cancelled || lifecycleCancellation.current !== undefined) operator.resumeAfterCancellation();
      if (result.cancelled && lifecycleCancellation.current === undefined) lifecycleCancellation.current = "exit";
      const terminalExit = lifecycleCancellation.current === "exit";
      if (cancelled && !terminalExit && !terminalLost.current) {
        lifecycleCancellation.current = undefined;
        if (mode === "configure") setScreen({ kind: "password" });
        else {
          await loadMenu({
            message:
              lifecycleResult?.status === "cancelled" ? lifecycleResult.summary : "Lifecycle operation cancelled.",
            tone: "yellow"
          });
        }
        return;
      }
      const failure = result.failure
        ? { error: result.failure.message }
        : lifecycleResult?.status === "failure"
          ? { error: lifecycleResult.error, snapshot: lifecycleResult.snapshot }
          : undefined;
      if (terminalExit) {
        exit(result.failure ?? (failure ? new Error(failure.error) : terminalLossError.current));
        return;
      }
      const snapshot = failure && "snapshot" in failure ? failure.snapshot : undefined;
      setScreen((current) =>
        current.kind === "operation"
          ? {
              ...current,
              view: {
                ...current.view,
                completedAt: Date.now(),
                ...(failure ? { error: failure.error } : {}),
                ...(snapshot ? { snapshot } : {}),
                ...(lifecycleResult?.status === "success" ? { summary: lifecycleResult.summary } : {}),
                ...(lifecycleResult?.status === "cancelled" ? { summary: lifecycleResult.summary } : {}),
                status: failure ? "failure" : cancelled ? "cancelled" : "success"
              }
            }
          : current
      );
      if (lifecycleResult?.status === "success") {
        if (mode === "configure") {
          await waitUntilRenderFlush();
          exit();
        } else await loadMenu({ message: lifecycleResult.summary, tone: "green" });
      }
    },
    [exit, loadMenu, mode, operator, waitUntilRenderFlush]
  );

  const cancelLifecycleOperation = useCallback(
    (disposition: "return" | "exit") => {
      if (activeLifecycleOperation.current === undefined) return;
      const cancellationRequested = lifecycleCancellation.current !== undefined;
      if (disposition === "exit") lifecycleCancellation.current = "exit";
      else lifecycleCancellation.current ??= "return";
      if (!cancellationRequested) operator.cancelPending();
      setScreen((current) => lifecycleCancellationScreen(current, "Cancellation requested. Waiting for safe cleanup."));
    },
    [operator]
  );

  const runPluginActivity = useCallback(
    async ({
      action,
      operation,
      plugin,
      targetVersion
    }: {
      action: PluginActivityView["action"];
      operation(reportActivity: PluginActivityReporter): Promise<PluginOperationOutcome>;
      plugin: PluginDeploymentStatus;
      targetVersion?: string;
    }) => {
      const operationId = pluginOperationGeneration.current + 1;
      pluginOperationGeneration.current = operationId;
      activePluginOperation.current = operationId;
      const startedAt = Date.now();
      pluginCancellationRequested.current = false;
      pluginCancellation.current = undefined;
      setScreen({
        kind: "plugin-activity",
        view: {
          action,
          events: [
            {
              elapsedMs: 0,
              level: "working",
              message: `${action} requested`,
              stage: "operation"
            }
          ],
          operationId,
          plugin,
          startedAt,
          status: "running",
          ...(targetVersion ? { targetVersion } : {})
        }
      });
      await waitUntilRenderFlush();
      const reportActivity: PluginActivityReporter = (activity) => {
        if (activePluginOperation.current !== operationId) return;
        setScreen((current) =>
          current.kind === "plugin-activity" && current.view.operationId === operationId
            ? {
                ...current,
                view: {
                  ...current.view,
                  events: [...current.view.events, { ...activity, elapsedMs: Date.now() - startedAt }]
                }
              }
            : current
        );
      };
      const result = await runCancelableOperation(operator, async () => await operation(reportActivity));
      if (activePluginOperation.current === operationId) activePluginOperation.current = undefined;
      const cancellationRequested = pluginCancellationRequested.current || result.cancelled;
      if (cancellationRequested) operator.resumeAfterCancellation();
      if (result.cancelled && pluginCancellation.current === undefined) pluginCancellation.current = "exit";
      if (terminalLost.current) {
        exit(result.failure ?? terminalLossError.current);
        return;
      }
      if (pluginCancellation.current === "exit") {
        exit(result.failure);
        return;
      }
      if (pluginCancellation.current === "return" && !result.failure && result.value?.status !== "success") {
        await loadPlugins();
        return;
      }
      let snapshot: DeploymentSnapshot | undefined;
      if (result.failure) {
        try {
          snapshot = await operator.snapshot();
        } catch {
          snapshot = undefined;
        }
      }
      setScreen((current) => {
        if (current.kind !== "plugin-activity" || current.view.operationId !== operationId) return current;
        const status = result.failure
          ? "failure"
          : result.value?.status === "cancelled" || result.cancelled
            ? "cancelled"
            : "success";
        return {
          ...current,
          view: {
            ...current.view,
            completedAt: Date.now(),
            ...(status === "failure" && result.failure ? { error: result.failure.message } : {}),
            ...(snapshot ? { snapshot } : {}),
            status
          }
        };
      });
    },
    [exit, loadPlugins, operator, waitUntilRenderFlush]
  );

  const togglePlugin = useCallback(
    async (plugin: PluginDeploymentStatus) => {
      await runPluginActivity({
        action: plugin.enabled ? "Disable" : "Enable",
        plugin,
        operation: async (reportActivity) =>
          plugin.enabled
            ? await operator.pluginDisable(plugin.pluginId, reportActivity)
            : await operator.pluginEnable(plugin.pluginId, reportActivity)
      });
    },
    [operator, runPluginActivity]
  );

  const cancelPluginActivity = useCallback(
    (disposition: "return" | "exit") => {
      const operationId = activePluginOperation.current;
      if (disposition === "exit") pluginCancellation.current = "exit";
      else pluginCancellation.current ??= "return";
      if (operationId === undefined || pluginCancellationRequested.current) return;
      pluginCancellationRequested.current = true;
      operator.cancelPending();
      setScreen((current) =>
        current.kind === "plugin-activity" &&
        current.view.operationId === operationId &&
        current.view.status === "running"
          ? {
              ...current,
              view: {
                ...current.view,
                events: [
                  ...current.view.events,
                  {
                    elapsedMs: Date.now() - current.view.startedAt,
                    level: "working",
                    message: "Cancellation requested. Waiting for safe cleanup",
                    stage: "operation"
                  }
                ],
                status: "cancelling"
              }
            }
          : current
      );
    },
    [operator]
  );

  const openPluginLogViewer = useCallback(
    async (plugin: PluginDeploymentStatus) => {
      if (!operator.openPluginLogStream) {
        setScreen({
          kind: "message",
          message: "Plugin log streaming is unavailable in this operator.",
          returnTo: "plugins"
        });
        return;
      }
      setScreen({ kind: "busy", label: "Opening Plugin logs..." });
      await waitUntilRenderFlush();
      try {
        const stream = await operator.openPluginLogStream(plugin.pluginId, true);
        const service = stream.service ?? plugin.pluginId;
        setScreen({
          kind: "log-viewer",
          returnTo: "plugins",
          service,
          services: [{ id: service, label: plugin.displayName }],
          stream,
          title: "ATLAS CORE > PLUGIN LOGS"
        });
      } catch (error) {
        setScreen({
          kind: "message",
          message: `Unable to open Plugin logs: ${errorMessage(error)}`,
          returnTo: "plugins"
        });
      }
    },
    [operator, waitUntilRenderFlush]
  );

  const installPlugin = useCallback(
    async (plugin: PluginDeploymentStatus) => {
      if (!operator.pluginInstall) return;
      await runPluginActivity({
        action: "Install",
        plugin,
        operation: async (reportActivity) => await operator.pluginInstall!(plugin.pluginId, undefined, reportActivity)
      });
    },
    [operator, runPluginActivity]
  );

  const reviewPluginUpdate = useCallback(
    async (plugin: PluginDeploymentStatus) => {
      if (!operator.pluginUpdatePlan) return;
      if (plugin.updatePlan) {
        setScreen({ kind: "plugin-update-review", plan: plugin.updatePlan });
        return;
      }
      setScreen({ kind: "busy", label: `Checking updates for ${plugin.displayName}...` });
      try {
        setScreen({ kind: "plugin-update-review", plan: await operator.pluginUpdatePlan(plugin.pluginId) });
      } catch (error) {
        setScreen({ kind: "plugins", view: new Error(errorMessage(error)) });
      }
    },
    [operator]
  );

  const updatePlugin = useCallback(
    async (plan: Extract<PluginUpdatePlan, { status: "available" }>) => {
      const pluginUpdate = operator.pluginUpdate;
      if (!pluginUpdate) return;
      await runPluginActivity({
        action: plan.action === "replacement" ? "Replace" : "Update",
        plugin: {
          pluginId: plan.pluginId,
          displayName: plan.displayName,
          lifecycle: "query_only",
          enabled: plan.enabled,
          packaged: false,
          installed: true,
          selectedVersion: plan.currentVersion
        },
        targetVersion: plan.targetVersion,
        operation: async (reportActivity) => await pluginUpdate.call(operator, plan.pluginId, reportActivity, plan)
      });
    },
    [operator, runPluginActivity]
  );

  const openLogViewer = useCallback(
    async (service: "api" | "minio" | "postgres" | "source-gateway" | undefined, returnTo: "menu" | "status") => {
      setScreen({ kind: "busy", label: "Opening live logs..." });
      await waitUntilRenderFlush();
      try {
        const stream = await operator.openLogStream(service, true);
        setScreen({
          kind: "log-viewer",
          returnTo,
          service,
          services: LOG_SERVICES,
          stream,
          title: "ATLAS CORE > LIVE LOGS"
        });
      } catch (error) {
        setScreen({ kind: "message", message: `Unable to open logs: ${errorMessage(error)}`, returnTo });
      }
    },
    [operator, waitUntilRenderFlush]
  );

  const runStructuredDiagnostics = useCallback(
    async (returnTo: "menu" | "status") => {
      setScreen({ kind: "busy", label: "Running diagnostics..." });
      await waitUntilRenderFlush();
      try {
        setScreen({ kind: "diagnostics", returnTo, view: await operator.diagnostics() });
      } catch (error) {
        setScreen({ kind: "diagnostics", returnTo, view: new Error(errorMessage(error)) });
      }
    },
    [operator, waitUntilRenderFlush]
  );

  const configureAdmin = useCallback(
    async (password: string) => {
      await runLifecycleOperation("configure", { password });
    },
    [runLifecycleOperation]
  );

  const applyUpdate = useCallback(
    async (info: UpdateInfo, scope: UpdateScope) => {
      const operationId = updateOperationGeneration.current + 1;
      updateOperationGeneration.current = operationId;
      activeUpdateOperation.current = operationId;
      updateCancellation.current = undefined;
      const startedAt = Date.now();
      setScreen({
        kind: "update-operation",
        view: {
          events: [
            { elapsedMs: 0, message: "Applying reviewed update...", stage: "operation" },
            {
              elapsedMs: 0,
              message: `${updateScopeLabel(info, scope)} update requested`,
              stage: "operation"
            }
          ],
          info,
          scope,
          startedAt,
          status: "running"
        }
      });
      await waitUntilRenderFlush();
      const report: UpdateReporter = (progress) => {
        if (activeUpdateOperation.current !== operationId) return;
        setScreen((current) =>
          current.kind === "update-operation"
            ? {
                ...current,
                view: {
                  ...current.view,
                  events: appendUpdateEvent(current.view.events, progress, Date.now() - startedAt)
                }
              }
            : current
        );
      };
      const result = await runCancelableOperation(operator, async () => {
        await operator.updateWithProgress(scope, info.latestVersion, report);
      });
      activeUpdateOperation.current = undefined;
      const requestedCancellation = updateCancellation.current;
      if ((result.cancelled || requestedCancellation !== undefined) && !terminalLost.current) {
        operator.resumeAfterCancellation();
      }
      if (result.cancelled && requestedCancellation === undefined) updateCancellation.current = "exit";
      const cancelled = result.cancelled;
      const status = result.failure ? "failure" : cancelled ? "cancelled" : "success";
      setScreen((current) =>
        current.kind === "update-operation"
          ? {
              ...current,
              view: {
                ...current.view,
                completedAt: Date.now(),
                ...(result.failure ? { error: result.failure.message } : {}),
                status
              }
            }
          : current
      );
      const cliUpdateCompleted = status === "success" && updateInvolvesCLI(info, scope);
      if (cliUpdateCompleted) {
        await waitUntilRenderFlush();
        exit();
        return;
      }
      if (cancelled && requestedCancellation === "return" && !terminalLost.current && !result.failure) {
        if (updateInvolvesCLI(info, scope)) {
          await waitUntilRenderFlush();
          exit();
          return;
        }
        updateCancellation.current = undefined;
        if (mode === "update") await loadUpdate();
        else await loadMenu({ message: "Update cancelled.", tone: "yellow" });
        return;
      }
      if (updateCancellation.current === "exit" || terminalLost.current) {
        exit(result.failure ?? terminalLossError.current);
      }
    },
    [exit, loadMenu, loadUpdate, mode, operator, waitUntilRenderFlush]
  );

  const cancelUpdateOperation = useCallback(
    (disposition: "return" | "exit") => {
      if (activeUpdateOperation.current === undefined) return;
      if (disposition === "exit") updateCancellation.current = "exit";
      else updateCancellation.current ??= "return";
      operator.cancelPending();
      setScreen((current) => updateCancellationScreen(current, "Cancellation requested. Waiting for safe cleanup."));
    },
    [operator]
  );

  if (screen.kind === "busy") {
    return <BusyScreen label={screen.label} onCancel={() => operator.cancelPending()} />;
  }
  if (screen.kind === "menu") {
    return (
      <ActionListMenu
        onSelect={(action) => {
          if (action === "status") void loadStatus();
          else if (action === "logs") setScreen({ kind: "logs" });
          else if (action === "plugins") void loadPlugins();
          else if (action === "update") void loadUpdate();
          else if (action === "init" || action === "start" || action === "stop" || action === "restart")
            void runLifecycleOperation(action);
          else if (action === "configure") setScreen({ kind: "password" });
          else if (action === "reset") setScreen({ kind: "reset-confirmation" });
        }}
        onExit={exit}
        {...(screen.notice ? { notice: screen.notice } : {})}
        snapshot={screen.snapshot}
      />
    );
  }
  if (screen.kind === "operation") {
    return (
      <LifecycleOperationScreen
        onBack={() =>
          mode === "configure"
            ? setScreen({ kind: "password", ...(screen.view.error ? { error: screen.view.error } : {}) })
            : void loadMenu()
        }
        onCancel={cancelLifecycleOperation}
        view={screen.view}
      />
    );
  }
  if (screen.kind === "update-operation") {
    return (
      <UpdateOperationScreen
        onBack={() => {
          const cliInvolved = updateInvolvesCLI(screen.view.info, screen.view.scope);
          if (screen.view.error && cliInvolved) {
            exit(new Error(screen.view.error));
          } else if (mode === "update") {
            exit(screen.view.error ? new Error(screen.view.error) : undefined);
          } else void loadMenu();
        }}
        onCancel={cancelUpdateOperation}
        returnToMenu={mode !== "update" && !updateInvolvesCLI(screen.view.info, screen.view.scope)}
        view={screen.view}
      />
    );
  }
  if (screen.kind === "message") {
    return (
      <MessageScreen
        message={screen.message}
        onBack={() => {
          if (screen.returnTo === "status") void loadStatus();
          else if (screen.returnTo === "plugins") void loadPlugins();
          else void loadMenu();
        }}
        title="Atlas Core"
      />
    );
  }
  if (screen.kind === "reset-confirmation") {
    return (
      <ResetConfirmationScreen
        onCancel={() => void loadMenu({ message: "Atlas Core reset cancelled.", tone: "yellow" })}
        onConfirm={() => void runLifecycleOperation("reset", { resetConfirmed: true })}
        onExit={exit}
      />
    );
  }
  if (screen.kind === "password") {
    return (
      <PasswordScreen
        {...(screen.error ? { error: screen.error } : {})}
        onCancel={() => {
          if (mode === "configure") exit(screen.error ? new Error(screen.error) : undefined);
          else void loadMenu();
        }}
        onSubmit={(password) => void configureAdmin(password)}
      />
    );
  }
  if (screen.kind === "logs") {
    return (
      <LogsMenu
        onBack={() => void loadMenu()}
        onDiagnostics={() => void runStructuredDiagnostics("menu")}
        onSelect={(service) => void openLogViewer(service, "menu")}
      />
    );
  }
  if (screen.kind === "log-viewer") {
    return (
      <LogViewer
        onBack={async () => {
          await screen.stream.close();
          if (screen.returnTo === "plugins") await loadPlugins();
          else if (screen.returnTo === "status") await loadStatus();
          else await loadMenu();
        }}
        onServiceChange={(service) => {
          if (
            screen.returnTo !== "plugins" &&
            (service === undefined ||
              service === "api" ||
              service === "minio" ||
              service === "postgres" ||
              service === "source-gateway")
          ) {
            void openLogViewer(service, screen.returnTo);
          }
        }}
        service={screen.service}
        services={screen.services}
        stream={screen.stream}
        title={screen.title}
      />
    );
  }
  if (screen.kind === "diagnostics") {
    return (
      <DiagnosticsScreen
        onBack={() => (screen.returnTo === "status" ? void loadStatus() : void loadMenu())}
        view={screen.view}
      />
    );
  }
  if (screen.kind === "plugins") {
    return (
      <PluginsMenu
        onBack={() => void loadMenu()}
        onInstall={operator.pluginInstall ? (plugin) => void installPlugin(plugin) : undefined}
        onLogs={(plugin) => void openPluginLogViewer(plugin)}
        onToggle={(plugin) => void togglePlugin(plugin)}
        onUpdate={
          operator.pluginUpdate && operator.pluginUpdatePlan ? (plugin) => void reviewPluginUpdate(plugin) : undefined
        }
        view={screen.view}
      />
    );
  }
  if (screen.kind === "plugin-update-review") {
    const plan = screen.plan;
    return (
      <PluginUpdateReview
        onBack={() => void loadPlugins()}
        onConfirm={plan.status === "available" ? () => void updatePlugin(plan) : undefined}
        plan={plan}
      />
    );
  }
  if (screen.kind === "plugin-activity") {
    return (
      <PluginActivityScreen onBack={() => void loadPlugins()} onCancel={cancelPluginActivity} view={screen.view} />
    );
  }
  if (screen.kind === "status") {
    return (
      <StatusScreen
        onBack={() => void loadMenu()}
        onDeactivate={invalidateStatus}
        onDiagnostics={() => void runStructuredDiagnostics("status")}
        onLogs={(service) => void openLogViewer(service, "status")}
        onReload={refreshStatus}
        view={screen.view}
      />
    );
  }
  if (screen.kind === "update-error") {
    return (
      <MessageScreen
        message={screen.message}
        onBack={() => {
          if (mode === "update") exit();
          else void loadMenu();
        }}
        title="Update check failed"
      />
    );
  }
  if (screen.kind === "update-review") {
    return (
      <UpdateReview
        info={screen.info}
        onApply={() => void applyUpdate(screen.info, screen.scope)}
        onBack={() => setScreen({ kind: "update", info: screen.info })}
        scope={screen.scope}
      />
    );
  }
  return (
    <UpdateMenu
      info={screen.info}
      onBack={() => (mode === "update" ? exit() : void loadMenu())}
      onReload={() => void loadUpdate()}
      onReview={(scope) => setScreen({ kind: "update-review", info: screen.info, scope })}
    />
  );
}

type ActionListAction = LifecycleOperation | "logs" | "plugins" | "status" | "update";

type ActionListChoice = {
  action: ActionListAction;
  label: string;
};

/**
 * Render the single shipped action-list home. The list is intentionally
 * unfiltered so every supported operation remains visible and discoverable.
 */
function ActionListMenu({
  notice,
  onExit,
  onSelect,
  snapshot
}: {
  notice?: Notice;
  onExit(): void;
  onSelect(action: ActionListAction): void;
  snapshot: DeploymentSnapshot;
}): ReactNode {
  const { columns, rows } = useWindowSize();
  const selectedRef = useRef(0);
  const actionPending = useRef(false);
  const [selected, setSelected] = useState(0);
  const choices = useMemo(() => actionListChoices(snapshot), [snapshot]);
  const index = Math.min(selected, Math.max(0, choices.length - 1));
  const summary = actionListSummary(snapshot, columns);
  const requiredRows = actionListMenuRows(summary, choices, columns, notice);
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS && rows >= requiredRows;

  useInput((input, key) => {
    if (actionPending.current) return;
    if (key.escape || (key.ctrl && input === "c") || input === "q") {
      actionPending.current = true;
      onExit();
      return;
    }
    if (!canInteract || hasCommandModifier(key)) return;
    if (key.upArrow || key.downArrow) {
      const next = (selectedRef.current + (key.downArrow ? 1 : -1) + choices.length) % Math.max(1, choices.length);
      selectedRef.current = next;
      setSelected(next);
      return;
    }
    if (key.return) {
      const choice = choices[selectedRef.current];
      if (!choice) return;
      actionPending.current = true;
      onSelect(choice.action);
    }
  });

  if (columns < MINIMUM_TERMINAL_COLUMNS) return <NarrowTerminal />;
  if (rows < requiredRows) return <ShortActionList requiredRows={requiredRows} />;

  return (
    <Box flexDirection="column" width={columns}>
      <Header right={stateName(snapshot.status)} title="ATLAS CORE" />
      <Box flexDirection="column">
        {summary.map(([label, value]) => (
          <Box key={label}>
            <Box width={Math.min(18, columns > 40 ? 18 : 12)}>
              <Text dimColor>{pad(label, Math.min(18, columns > 40 ? 18 : 12))}</Text>
            </Box>
            <Text wrap="wrap">{value}</Text>
          </Box>
        ))}
      </Box>
      {notice ? <Text color={notice.tone}>{notice.message}</Text> : null}
      <Rule width={columns} />
      <Text bold>CHOOSE AN ACTION</Text>
      {choices.map((choice, choiceIndex) => (
        <Text inverse={choiceIndex === index} key={choice.label}>
          {pad(`${choiceIndex === index ? "›" : " "}  ${choice.label}`, columns)}
        </Text>
      ))}
      <Rule width={columns} />
      <Text dimColor>{"↑/↓ move   Enter select   Esc exit"}</Text>
    </Box>
  );
}

function actionListChoices(snapshot: DeploymentSnapshot): ActionListChoice[] {
  const choices: ActionListChoice[] = [
    { action: "status", label: "View service health" },
    { action: "logs", label: "View logs and diagnostics" }
  ];
  if (snapshot.status === "not-initialized") {
    choices.push({ action: "init", label: "Initialize Atlas Core" });
  } else if (snapshot.status === "initializing") {
    choices.push({ action: "init", label: "Retry initialization" });
  } else if (snapshot.status === "ready") {
    choices.push({ action: "stop", label: "Stop Atlas Core" }, { action: "restart", label: "Restart Atlas Core" });
  } else if (snapshot.status === "degraded") {
    choices.push({ action: "stop", label: "Stop Atlas Core" });
  } else if (snapshot.status === "stopped") {
    choices.push({ action: "start", label: "Start Atlas Core" });
  }
  choices.push({ action: "plugins", label: "Manage Plugins" }, { action: "update", label: "Update Atlas Core" });
  if (snapshot.status !== "not-initialized") {
    choices.push({ action: "configure", label: "Change admin password" });
    if (snapshot.canReset) choices.push({ action: "reset", label: "Reset Atlas Core" });
  }
  return choices;
}

function actionListSummary(snapshot: DeploymentSnapshot, width: number): KeyValue[] {
  const status =
    snapshot.status === "ready"
      ? "Running"
      : snapshot.status === "stopped"
        ? "Stopped"
        : snapshot.status === "degraded"
          ? "Degraded"
          : snapshot.status === "initializing"
            ? "Initializing"
            : "Not initialized";
  const labelWidth = Math.min(18, width > 40 ? 18 : 12);
  const detailWidth = Math.max(1, width - labelWidth);
  return [
    ["Deployment", "local-engine"],
    [
      "Core",
      snapshot.status === "not-initialized"
        ? "Not initialized"
        : snapshot.coreVersion
          ? `v${snapshot.coreVersion}`
          : "Version unavailable"
    ],
    ["Status", status],
    ["Detail", firstTerminalLine(snapshot.detail, detailWidth)]
  ];
}

function actionListMenuRows(summary: KeyValue[], choices: ActionListChoice[], width: number, notice?: Notice): number {
  const labelWidth = Math.min(18, width > 40 ? 18 : 12);
  const summaryRows = summary.reduce(
    (rows, [, value]) => rows + wrappedRows(value, Math.max(1, width - labelWidth)),
    0
  );
  const noticeRows = notice ? wrappedRows(notice.message, width) : 0;
  return 1 + summaryRows + noticeRows + 1 + 1 + Math.max(1, choices.length) + 1 + 1;
}

function ShortActionList({ requiredRows }: { requiredRows: number }): ReactNode {
  const { exit } = useApp();
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c") || input === "q") exit();
  });
  return (
    <Box flexDirection="column">
      <Header title="ATLAS CORE" />
      <Text>Action list needs at least {requiredRows} rows.</Text>
      <Text dimColor>Resize the terminal or press Esc to exit.</Text>
    </Box>
  );
}

function ResetConfirmationScreen({
  onCancel,
  onConfirm,
  onExit
}: {
  onCancel(): void;
  onConfirm(): void;
  onExit(): void;
}): ReactNode {
  const { columns, rows } = useWindowSize();
  const answerRef = useRef("");
  const pendingRef = useRef(false);
  const [answer, setAnswer] = useState("");
  const hasEnoughColumns = columns >= MINIMUM_TERMINAL_COLUMNS;
  const hasEnoughRows = rows >= resetConfirmationRows(columns);
  const canInteract = hasEnoughColumns && hasEnoughRows;

  useInput((input, key) => {
    if (pendingRef.current) return;
    if (key.ctrl && input === "c") {
      pendingRef.current = true;
      onExit();
      return;
    }
    if (key.escape) {
      pendingRef.current = true;
      onCancel();
      return;
    }
    if (!canInteract) return;
    if (key.backspace || key.delete) {
      answerRef.current = Array.from(answerRef.current).slice(0, -1).join("");
      setAnswer(answerRef.current);
      return;
    }
    const typed = input.replace(/[\r\n]/gu, "");
    if (typed && isPrintableInput(typed, key)) {
      answerRef.current += typed;
      setAnswer(answerRef.current);
    }
    if (key.return || /[\r\n]/u.test(input)) {
      pendingRef.current = true;
      if (/^(?:y|yes)$/iu.test(answerRef.current.trim())) onConfirm();
      else onCancel();
    }
  });

  if (!hasEnoughColumns || !hasEnoughRows) {
    return (
      <Box flexDirection="column" width={columns}>
        <Header title="ATLAS CORE > RESET" />
        <Text>
          Resize terminal to at least {hasEnoughColumns ? `${resetConfirmationRows(columns)} rows` : "40 columns"}.
        </Text>
        <Text dimColor>Esc cancels reset. State is unchanged until confirmation.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={columns}>
      <Header title="ATLAS CORE > RESET" />
      <Rule width={columns} />
      <Text color="yellow" bold>
        Reset permanently deletes this deployment.
      </Text>
      <Text wrap="wrap">{RESET_CONFIRMATION_DESCRIPTION}</Text>
      <Text> </Text>
      <Text>Type yes to continue, or no to cancel:</Text>
      <Text>{`> ${answer}`}</Text>
      <Rule width={columns} />
      <Text dimColor>Enter confirm Esc cancel Ctrl+C exit</Text>
    </Box>
  );
}

function resetConfirmationRows(width: number): number {
  return 1 + 1 + 1 + wrappedRows(RESET_CONFIRMATION_DESCRIPTION, width) + 1 + 1 + 1 + 1 + 1;
}

function StatusScreen({
  onBack,
  onDeactivate,
  onDiagnostics,
  onLogs,
  onReload,
  view
}: {
  onBack(): void;
  onDeactivate(): void;
  onDiagnostics(): void;
  onLogs(service: DeploymentService["id"]): void;
  onReload(): Promise<void>;
  view: DeploymentDetails | Error;
}): ReactNode {
  const { columns, rows } = useWindowSize();
  const actionPending = useRef(false);
  const scrollRef = useRef(0);
  const selectedRef = useRef(0);
  const [scroll, setScroll] = useState(0);
  const [selected, setSelected] = useState(0);
  const services = view instanceof Error ? [] : view.services;
  const index = Math.min(selected, Math.max(0, services.length - 1));
  const hasEnoughColumns = columns >= MINIMUM_TERMINAL_COLUMNS;
  const service = services[index];
  const bodyRows = view instanceof Error ? statusErrorBodyRows(view, columns) : statusBodyRows(view, service, columns);
  const headerRows =
    view instanceof Error ? wrappedRows("ATLAS CORE > STATUS", columns) + 1 : statusHeaderRows(view, columns);
  const refreshControl = view instanceof Error ? "r retry" : "r refresh";
  const footerTemplate = statusFooterText(
    bodyRows > 0 ? { first: bodyRows, last: bodyRows, total: bodyRows } : undefined,
    services.length,
    refreshControl
  );
  const footerRows = 1 + wrappedRows(footerTemplate, columns);
  const requiredRows = headerRows + footerRows + 1;
  const hasEnoughRows = rows >= requiredRows;
  const viewportRows = Math.max(1, rows - headerRows - footerRows);
  const maxScroll = Math.max(0, bodyRows - viewportRows);
  const scrollOffset = Math.min(scroll, maxScroll);
  scrollRef.current = scrollOffset;
  const footer = statusFooterText(
    maxScroll > 0
      ? {
          first: scrollOffset + 1,
          last: Math.min(bodyRows, scrollOffset + viewportRows),
          total: bodyRows
        }
      : undefined,
    services.length,
    refreshControl
  );
  const canInteract = hasEnoughColumns && hasEnoughRows;

  useEffect(() => {
    setScroll((current) => Math.min(current, maxScroll));
  }, [maxScroll]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      timer = setTimeout(() => {
        void onReload().finally(() => {
          if (!stopped) schedule();
        });
      }, STATUS_REFRESH_INTERVAL_MS);
    };
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      onDeactivate();
    };
  }, [onDeactivate, onReload]);

  useInput((input, key) => {
    if (actionPending.current) return;
    const modified = hasCommandModifier(key);
    if (key.escape || key.return || (key.ctrl && input === "c") || (!modified && input === "q")) {
      actionPending.current = true;
      onBack();
    } else if (!canInteract || modified) return;
    else if (input === "r") {
      void onReload();
    } else if (input === "d") {
      actionPending.current = true;
      onDiagnostics();
    } else if (key.upArrow && maxScroll > 0) {
      const next = Math.max(0, scrollRef.current - 1);
      scrollRef.current = next;
      setScroll(next);
    } else if (key.downArrow && maxScroll > 0) {
      const next = Math.min(maxScroll, scrollRef.current + 1);
      scrollRef.current = next;
      setScroll(next);
    } else if (key.leftArrow && services.length > 0) {
      const next = (Math.min(selectedRef.current, services.length - 1) - 1 + services.length) % services.length;
      selectedRef.current = next;
      setSelected(next);
      scrollRef.current = 0;
      setScroll(0);
    } else if (key.rightArrow && services.length > 0) {
      const next = (Math.min(selectedRef.current, services.length - 1) + 1) % services.length;
      selectedRef.current = next;
      setSelected(next);
      scrollRef.current = 0;
      setScroll(0);
    } else if (input === "l") {
      const service = services[Math.min(selectedRef.current, Math.max(0, services.length - 1))];
      if (service) {
        actionPending.current = true;
        onLogs(service.id);
      }
    }
  });

  if (!hasEnoughColumns) return <NarrowTerminal />;
  if (!hasEnoughRows) return <ShortStatusTerminal requiredRows={requiredRows} />;
  const width = columns;

  return (
    <Box flexDirection="column" width={width}>
      {view instanceof Error ? (
        <>
          <Header title="ATLAS CORE > STATUS" />
          <Rule width={width} />
        </>
      ) : (
        <>
          <Header
            right={`${stateName(view.snapshot.status)}  Core v${view.coreVersion}  CLI v${view.cliVersion}`}
            title="ATLAS CORE > STATUS"
          />
          <Text>{view.snapshot.detail}</Text>
          {width >= 72 ? (
            <Text dimColor>{`API ${view.apiEndpoint}   MinIO ${view.minioEndpoint}`}</Text>
          ) : (
            <>
              <Text dimColor>API {view.apiEndpoint}</Text>
              <Text dimColor>MinIO {view.minioEndpoint}</Text>
            </>
          )}
          <Rule width={width} />
        </>
      )}
      <Box height={viewportRows} overflowY="hidden">
        <Box flexDirection="column" flexShrink={0} position="relative" top={-scrollOffset}>
          {view instanceof Error ? (
            <StatusErrorBody error={view} />
          ) : (
            <StatusBody index={index} service={service} view={view} width={width} />
          )}
        </Box>
      </Box>
      <Rule width={width} />
      <Text dimColor>{footer}</Text>
    </Box>
  );
}

function StatusErrorBody({ error }: { error: Error }): ReactNode {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text bold color="red">
        Status unavailable
      </Text>
      <Text>{error.message}</Text>
    </Box>
  );
}

function StatusBody({
  index,
  service,
  view,
  width
}: {
  index: number;
  service: DeploymentService | undefined;
  view: DeploymentDetails;
  width: number;
}): ReactNode {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text bold>SERVICES</Text>
      {width >= 72 ? (
        <Box>
          {view.services.map((candidate, candidateIndex) => (
            <Text inverse={candidateIndex === index} key={candidate.id}>
              {` ${candidate.label} `}
            </Text>
          ))}
        </Box>
      ) : (
        view.services.map((candidate, candidateIndex) => (
          <Text inverse={candidateIndex === index} key={candidate.id}>
            {pad(`${candidateIndex === index ? ">" : " "} ${candidate.label}`, width)}
          </Text>
        ))
      )}
      <Text> </Text>
      {service ? (
        <ServiceDetails service={service} width={width} />
      ) : (
        <Text>No Atlas Core containers are running.</Text>
      )}
      <Text> </Text>
      <Text bold>DEPLOYMENT</Text>
      <KeyValues values={deploymentValues(view)} width={width} />
      {view.performanceError ? (
        <Text color="yellow">Performance statistics unavailable: {view.performanceError}</Text>
      ) : null}
    </Box>
  );
}

function ServiceDetails({ service, width }: { service: DeploymentService; width: number }): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold>{service.label}</Text>
      <KeyValues values={serviceValues(service)} width={width} />
    </Box>
  );
}

function KeyValues({ values, width }: { values: KeyValue[]; width: number }): ReactNode {
  const labelWidth = Math.min(14, Math.max(...values.map(([label]) => label.length)));
  return values.map(([label, value]) => (
    <Box key={label} width={width}>
      <Box width={labelWidth + 2}>
        <Text dimColor>{pad(label, labelWidth)}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="wrap">{value}</Text>
      </Box>
    </Box>
  ));
}

function serviceValues(service: DeploymentService): KeyValue[] {
  const status = `${service.state || "unknown"}${service.health ? `, ${service.health}` : ""}`;
  return [
    ["Status", status],
    ["Container", service.container],
    ["Uptime", service.uptime ?? "Not running"],
    ["Restarts", service.restarts?.toString() ?? "Not available"],
    ["CPU", service.cpuPercent ?? "Not available"],
    ["Memory", joinMetric(service.memoryUsage, service.memoryPercent)],
    ["Network I/O", service.networkIO ?? "Not available"],
    ["Block I/O", service.blockIO ?? "Not available"],
    ["Processes", service.processes ?? "Not available"],
    ["Image", service.image ?? "Not available"]
  ];
}

function deploymentValues(view: DeploymentDetails): KeyValue[] {
  return [
    ["Initialized", view.initializedAt],
    ["Image", view.image ?? "No running Core image"],
    ["Configuration", "Credentials and durable volumes preserved"]
  ];
}

function statusHeaderRows(view: DeploymentDetails, width: number): number {
  const right = `${stateName(view.snapshot.status)}  Core v${view.coreVersion}  CLI v${view.cliVersion}`;
  const endpointRows =
    width >= 72
      ? wrappedRows(`API ${view.apiEndpoint}   MinIO ${view.minioEndpoint}`, width)
      : wrappedRows(`API ${view.apiEndpoint}`, width) + wrappedRows(`MinIO ${view.minioEndpoint}`, width);
  return (
    wrappedRows(`ATLAS CORE > STATUS ${right}`, width) + wrappedRows(view.snapshot.detail, width) + endpointRows + 1
  );
}

function statusBodyRows(view: DeploymentDetails, service: DeploymentService | undefined, width: number): number {
  const serviceRows = service
    ? wrappedRows(service.label, width) + keyValueRows(serviceValues(service), width)
    : wrappedRows("No Atlas Core containers are running.", width);
  const serviceChoiceRows = width >= 72 ? (view.services.length > 0 ? 1 : 0) : view.services.length;
  const performanceRows = view.performanceError
    ? wrappedRows(`Performance statistics unavailable: ${view.performanceError}`, width)
    : 0;
  return (
    1 + serviceChoiceRows + 1 + serviceRows + 1 + 1 + keyValueRows(deploymentValues(view), width) + performanceRows
  );
}

function statusErrorBodyRows(error: Error, width: number): number {
  return 1 + wrappedRows(error.message, width);
}

function statusFooterText(
  scroll: { first: number; last: number; total: number } | undefined,
  serviceCount: number,
  refreshControl: "r refresh" | "r retry"
): string {
  const controls = [
    ...(scroll ? [`↑/↓ ${scroll.first}-${scroll.last}/${scroll.total}`] : []),
    ...(serviceCount > 1 ? ["←/→ service"] : []),
    ...(serviceCount > 0 ? ["l logs"] : []),
    "d diagnostics",
    refreshControl,
    "Enter back",
    "live 5s"
  ];
  return controls.join("  ");
}

function keyValueRows(values: KeyValue[], width: number): number {
  const labelWidth = Math.min(14, Math.max(...values.map(([label]) => label.length)));
  const valueWidth = Math.max(1, width - labelWidth - 2);
  return values.reduce((rows, [, value]) => rows + wrappedRows(value, valueWidth), 0);
}

function wrappedRows(value: string, width: number): number {
  const lineWidth = Math.max(1, width);
  return wrapAnsi(value, lineWidth, { hard: true, trim: false }).split("\n").length;
}

function firstTerminalLine(value: string, width: number): string {
  return (
    wrapAnsi(value.replace(/\s+/gu, " ").trim(), Math.max(1, width), { hard: true, trim: false }).split("\n")[0] ?? ""
  );
}

function LogsMenu({
  onBack,
  onDiagnostics,
  onSelect
}: {
  onBack(): void;
  onDiagnostics(): void;
  onSelect(service: DeploymentService["id"] | undefined): void;
}): ReactNode {
  const choices: Array<{ label: string; service: DeploymentService["id"] | undefined }> = [
    { label: "All services", service: undefined },
    { label: "Core API", service: "api" },
    { label: "Source Gateway", service: "source-gateway" },
    { label: "PostgreSQL", service: "postgres" },
    { label: "MinIO", service: "minio" }
  ];
  const menuChoices = [...choices.map(({ label }) => label), "Run diagnostics", "Back"];
  return (
    <SimpleMenu
      choices={menuChoices}
      onBack={onBack}
      onSelect={(index) => {
        const choice = choices[index];
        if (choice) onSelect(choice.service);
        else if (index === choices.length) onDiagnostics();
        else onBack();
      }}
      title="Logs and diagnostics"
    />
  );
}

const LOG_SERVICES: Array<{ id: DeploymentService["id"] | undefined; label: string }> = [
  { id: undefined, label: "All services" },
  { id: "api", label: "Core API" },
  { id: "source-gateway", label: "Source Gateway" },
  { id: "postgres", label: "PostgreSQL" },
  { id: "minio", label: "MinIO" }
];

function LogViewer({
  onBack,
  onServiceChange,
  service,
  services = LOG_SERVICES,
  stream,
  title = "ATLAS CORE > LIVE LOGS"
}: {
  onBack(): Promise<void>;
  onServiceChange(service: string | undefined): void;
  service: string | undefined;
  services?: readonly LogServiceOption[];
  stream: LogStream;
  title?: string;
}): ReactNode {
  const { columns, rows } = useWindowSize();
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const bufferRef = useRef(new LogBuffer());
  const selectedRef = useRef(
    Math.max(
      0,
      services.findIndex((candidate) => candidate.id === service)
    )
  );
  const actionPending = useRef(false);
  const [revision, setRevision] = useState(0);
  const [streamEnded, setStreamEnded] = useState(false);
  const [streamError, setStreamError] = useState<Error>();
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS;
  const selected = Math.min(selectedRef.current, Math.max(0, services.length - 1));
  const serviceLabel = services[selected]?.label ?? "Selected service";
  const streamStatus = streamError
    ? "error"
    : streamEnded
      ? "ended"
      : bufferRef.current.following
        ? "following"
        : "paused";
  const streamErrorSummary = streamError ? firstTerminalLine(`ERROR: ${streamError.message}`, columns) : undefined;
  const footer = `${streamStatus}   ←→ service   ↑↓ scroll   space pause/follow   End latest   Esc close`;
  const headerRows = streamErrorSummary ? 3 : 2;
  const footerRows = wrappedRows(footer, columns);
  const viewportRows = Math.max(1, rows - headerRows - footerRows - 2);

  useEffect(() => {
    const buffer = bufferRef.current;
    buffer.setWidth(columns);
    buffer.setViewport(viewportRows);
    setRevision((value) => value + 1);
  }, [columns, viewportRows]);

  useEffect(() => {
    const buffer = bufferRef.current;
    let active = true;
    setStreamEnded(false);
    setStreamError(undefined);
    const removeLine = stream.onLine((line) => {
      buffer.setWidth(columnsRef.current);
      buffer.append(line);
      setRevision((value) => value + 1);
    });
    const removeError = stream.onError((error) => {
      setStreamError(error);
      setRevision((value) => value + 1);
    });
    void stream.wait().then(
      () => {
        if (!active) return;
        setStreamEnded(true);
        setRevision((value) => value + 1);
      },
      (error: unknown) => {
        if (!active) return;
        setStreamError(error instanceof Error ? error : new Error(errorMessage(error)));
        setRevision((value) => value + 1);
      }
    );
    return () => {
      active = false;
      removeLine();
      removeError();
      void stream.close();
    };
  }, [stream]);

  useInput((input, key) => {
    if (actionPending.current) return;
    if (key.escape || (key.ctrl && input === "c")) {
      actionPending.current = true;
      void onBack();
      return;
    }
    if (!canInteract) return;
    if ((key.leftArrow || key.rightArrow) && services.length > 1) {
      const next = (selected + (key.rightArrow ? 1 : -1) + services.length) % Math.max(1, services.length);
      selectedRef.current = next;
      actionPending.current = true;
      onServiceChange(services[next]?.id);
      return;
    }
    if (key.upArrow) {
      bufferRef.current.scroll(-1);
      setRevision((value) => value + 1);
    } else if (key.downArrow) {
      bufferRef.current.scroll(1);
      setRevision((value) => value + 1);
    } else if (key.end) {
      bufferRef.current.followLatest();
      setRevision((value) => value + 1);
    } else if (input === " ") {
      bufferRef.current.toggleFollowing();
      setRevision((value) => value + 1);
    }
  });

  const snapshot = bufferRef.current.snapshot();
  if (columns < MINIMUM_TERMINAL_COLUMNS) {
    return (
      <Box flexDirection="column" width={columns}>
        <Header title={title} />
        <Text>Resize terminal to at least 40 columns.</Text>
        <Text dimColor>Esc closes the stream. Buffered output is preserved.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={columns}>
      <Header right={streamStatus.toUpperCase()} title={title} />
      <Text>
        <Text dimColor>Service </Text>
        <Text color="cyan">{serviceLabel}</Text>
      </Text>
      {streamErrorSummary ? <Text color="red">{streamErrorSummary}</Text> : null}
      <Rule width={columns} />
      <Box flexDirection="column" height={viewportRows} overflowY="hidden">
        {snapshot.lines.length === 0 ? (
          <Text dimColor>{streamEnded ? "Log stream ended." : "Waiting for log output..."}</Text>
        ) : null}
        {snapshot.lines.map((line, index) => (
          <Text key={`${snapshot.firstLine + index}-${revision}`}>{line || " "}</Text>
        ))}
      </Box>
      <Rule width={columns} />
      <Text dimColor>{footer}</Text>
    </Box>
  );
}

function DiagnosticsScreen({ onBack, view }: { onBack(): void; view: DiagnosticsResult | Error }): ReactNode {
  const { columns, rows } = useWindowSize();
  const actionPending = useRef(false);
  const scrollRef = useRef(0);
  const [scroll, setScroll] = useState(0);
  const lines = diagnosticsLines(view, columns);
  const headerRows = wrappedRows("ATLAS CORE > DIAGNOSTICS", columns) + 1;
  const footerTemplate = "↑/↓ scroll   Enter or Esc back";
  const footerRows = 1 + wrappedRows(footerTemplate, columns);
  const viewportRows = Math.max(1, rows - headerRows - footerRows);
  const maxScroll = Math.max(0, lines.length - viewportRows);
  const hasEnoughColumns = columns >= MINIMUM_TERMINAL_COLUMNS;
  const hasEnoughRows = rows >= headerRows + footerRows + 1;
  const canScroll = hasEnoughColumns && hasEnoughRows && maxScroll > 0;
  const scrollOffset = Math.min(scroll, maxScroll);
  scrollRef.current = scrollOffset;
  const footer = maxScroll > 0 ? footerTemplate : "Enter or Esc back";

  useEffect(() => {
    setScroll((current) => Math.min(current, maxScroll));
  }, [maxScroll]);

  useInput((input, key) => {
    if (actionPending.current) return;
    if (key.escape || key.return || (key.ctrl && input === "c") || input === "q") {
      actionPending.current = true;
      onBack();
    } else if (hasCommandModifier(key)) return;
    else if (key.upArrow && canScroll) {
      const next = Math.max(0, scrollRef.current - 1);
      scrollRef.current = next;
      setScroll(next);
    } else if (key.downArrow && canScroll) {
      const next = Math.min(maxScroll, scrollRef.current + 1);
      scrollRef.current = next;
      setScroll(next);
    }
  });
  if (columns < MINIMUM_TERMINAL_COLUMNS) {
    return (
      <Box flexDirection="column" width={columns}>
        <Header title="ATLAS CORE > DIAGNOSTICS" />
        <Text>Resize terminal to at least 40 columns.</Text>
        <Text dimColor>Esc returns without changing the deployment.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" width={columns}>
      <Header title="ATLAS CORE > DIAGNOSTICS" />
      <Rule width={columns} />
      <Box height={viewportRows} overflowY="hidden">
        <Box flexDirection="column" flexShrink={0} position="relative" top={-scrollOffset}>
          {lines.map((line, index) => (
            <Text {...(line.color ? { color: line.color } : {})} key={`${index}-${line.text}`}>
              {line.text || " "}
            </Text>
          ))}
        </Box>
      </Box>
      <Rule width={columns} />
      <Text dimColor>{footer}</Text>
    </Box>
  );
}

function diagnosticsLines(view: DiagnosticsResult | Error, width: number): ActivityLine[] {
  if (view instanceof Error) {
    return activityMessageLines({ color: "red", text: `Diagnostics failed: ${view.message}` }, width);
  }
  return [
    { color: view.healthy ? "green" : "red", text: view.healthy ? "All checks passed." : "Checks failed." },
    ...view.checks.flatMap((check) =>
      activityMessageLines(
        {
          color: check.status === "ok" ? "green" : "red",
          text: `[${check.status === "ok" ? "ok" : "fail"}] ${check.label}: ${check.detail}`
        },
        width
      )
    )
  ];
}

function PluginActivityScreen({
  onBack,
  onCancel,
  view
}: {
  onBack(): void;
  onCancel(disposition: "return" | "exit"): void;
  view: PluginActivityView;
}): ReactNode {
  const { columns, rows } = useWindowSize();
  const [now, setNow] = useState(Date.now());
  const finished = view.status === "success" || view.status === "failure" || view.status === "cancelled";

  useEffect(() => {
    if (finished) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [finished]);

  useInput((input, key) => {
    if (!finished && key.escape) {
      onCancel("return");
      return;
    }
    if (!finished && key.ctrl && input === "c") {
      onCancel("exit");
      return;
    }
    if (finished && (key.return || key.escape)) onBack();
    else if (finished && key.ctrl && input === "c") onBack();
  });

  if (columns < MINIMUM_TERMINAL_COLUMNS) return <NarrowTerminal />;
  const elapsed = (view.completedAt ?? now) - view.startedAt;
  const detail = `${view.action} ${view.plugin.displayName}  ${formatActivityTime(elapsed)}`;
  const wide = columns >= 72;
  const footer = finished
    ? "Enter return to Plugins"
    : view.status === "cancelling"
      ? "Cancelling safely. Waiting for cleanup..."
      : "Esc return after safe cleanup   Ctrl+C exit after safe cleanup";
  const headerRows = 1 + (wide ? 0 : wrappedRows(detail, columns));
  const viewportRows = rows - headerRows - wrappedRows(footer, columns) - 2;

  if (viewportRows < 1) {
    const compactFooter = view.status === "cancelling" ? "Waiting for safe cleanup..." : footer;
    const summary = pluginActivitySummary(view);
    const compactHeader =
      finished && rows <= 2 ? `ACTIVITY ${view.status.toUpperCase()}` : `ACTIVITY ${formatActivityTime(elapsed)}`;
    if (rows <= 1) return <Text>{compactHeader}</Text>;
    const detailRows = Math.max(0, rows - 2);
    const detailLines = activityMessageLines(
      summary ?? { text: `${view.action} ${view.plugin.displayName}` },
      columns
    ).slice(0, detailRows);
    return (
      <Box flexDirection="column" width={columns}>
        <Header title={compactHeader} />
        {detailLines.map((line, index) => (
          <Text
            {...(line.color ? { color: line.color } : {})}
            {...(line.dim === undefined ? {} : { dimColor: line.dim })}
            key={`${index}-${line.text}`}
          >
            {line.text}
          </Text>
        ))}
        <Text dimColor={view.status !== "failure"}>{compactFooter}</Text>
      </Box>
    );
  }
  const lines = pluginActivityLines(view, columns).slice(-viewportRows);

  return (
    <Box flexDirection="column" width={columns}>
      {wide ? <Header right={detail} title="ATLAS CORE > ACTIVITY" /> : <Header title="ATLAS CORE > ACTIVITY" />}
      {wide ? null : <Text dimColor>{detail}</Text>}
      <Rule width={columns} />
      <Box flexDirection="column" height={viewportRows} justifyContent="flex-end">
        {lines.map((line, index) => (
          <Text
            {...(line.color ? { color: line.color } : {})}
            {...(line.dim === undefined ? {} : { dimColor: line.dim })}
            key={`${index}-${line.text}`}
          >
            {line.text || " "}
          </Text>
        ))}
      </Box>
      <Rule width={columns} />
      <Text dimColor={view.status !== "failure"}>{footer}</Text>
    </Box>
  );
}

type ActivityLine = {
  color?: "green" | "red" | "yellow" | undefined;
  dim?: boolean | undefined;
  text: string;
};

function pluginActivityLines(view: PluginActivityView, width: number): ActivityLine[] {
  const lines = view.events.flatMap((event) => {
    const marker = event.level === "working" ? "[work]" : event.level === "success" ? "[done]" : "[fail]";
    const prefix = `${formatActivityTime(event.elapsedMs)} ${marker} `;
    const wrapped = wrapAnsi(`${prefix}${event.message}`, width, { hard: true, trim: false }).split("\n");
    const color: ActivityLine["color"] =
      event.level === "success" ? "green" : event.level === "failure" ? "red" : undefined;
    return wrapped.map((text) => ({ color, dim: event.level === "working", text }));
  });
  const summary = pluginActivitySummary(view);
  if (!summary) return lines;
  return [...lines, { text: "" }, ...activityMessageLines(summary, width)];
}

function pluginActivitySummary(view: PluginActivityView): ActivityLine | undefined {
  if (view.status === "success") {
    if ((view.action === "Update" || view.action === "Replace") && view.targetVersion) {
      return {
        color: "green",
        text: `${view.plugin.displayName} ${view.action === "Replace" ? "replaced with" : "updated to"} ${view.targetVersion}.`
      };
    }
    const verb =
      view.action === "Install"
        ? "installed"
        : view.action === "Enable"
          ? "enabled"
          : view.action === "Update"
            ? "updated"
            : view.action === "Replace"
              ? "replaced"
              : "disabled";
    return {
      color: "green",
      text: `${view.plugin.displayName} ${verb}.`
    };
  }
  if (view.status === "cancelled") {
    const preserved = view.action === "Update" || view.action === "Replace" ? "Plugin release" : "deployment";
    return { color: "yellow", text: `${view.action} cancelled. The previous ${preserved} is preserved.` };
  }
  if (view.status === "failure") {
    const lines = [view.error ? `${view.action} failed: ${view.error}` : `${view.action} failed.`];
    if (view.snapshot) {
      lines.push(`Deployment state: ${lifecycleSnapshotStatus(view.snapshot.status)}. ${view.snapshot.detail}`);
    }
    lines.push(pluginRecoveryHint(view));
    return { color: "red", text: lines.join(" ") };
  }
  return undefined;
}

function pluginRecoveryHint(view: PluginActivityView): string {
  if (/recovery remains pending|Plugin recovery is pending|pending/i.test(view.error ?? "")) {
    return "Run atlas-core recover status, finish the pending recovery, then retry the Plugin operation.";
  }
  if (view.snapshot?.status === "stopped") {
    return "Resolve the reported Plugin error, then retry the Plugin operation while Atlas Core remains stopped.";
  }
  if (view.snapshot?.status === "degraded") return "Review service health, then retry the Plugin operation when safe.";
  return "Review Plugin status or run atlas-core recover status before retrying.";
}

function activityMessageLines(line: ActivityLine, width: number): ActivityLine[] {
  return wrapAnsi(line.text, width, { hard: true, trim: false })
    .split("\n")
    .map((text) => ({ ...line, text }));
}

function formatActivityTime(milliseconds: number): string {
  const tenths = Math.max(0, Math.floor(milliseconds / 100));
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${tenths % 10}`;
}

function LifecycleOperationScreen({
  onBack,
  onCancel,
  view
}: {
  onBack(): void;
  onCancel(disposition: "return" | "exit"): void;
  view: LifecycleOperationView;
}): ReactNode {
  const { columns, rows } = useWindowSize();
  const [now, setNow] = useState(Date.now());
  const finished = view.status === "success" || view.status === "failure" || view.status === "cancelled";

  useEffect(() => {
    if (finished) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [finished]);

  useInput((input, key) => {
    if (!finished && key.ctrl && input === "c") {
      onCancel("exit");
      return;
    }
    if (!finished && key.escape) {
      onCancel("return");
      return;
    }
    if (finished && (key.return || key.escape || (key.ctrl && input === "c"))) onBack();
  });

  const elapsed = (view.completedAt ?? now) - view.startedAt;
  const title = lifecycleOperationLabel(view.operation);
  const detail = `${title}  ${formatActivityTime(elapsed)}`;
  const footer = finished
    ? "Enter return to Atlas Core"
    : view.status === "cancelling"
      ? "Cancelling safely. Waiting for cleanup..."
      : "Esc cancel safely   Ctrl+C cancel and exit";
  if (columns < MINIMUM_TERMINAL_COLUMNS) {
    return (
      <Box flexDirection="column" width={columns}>
        <Header title="ATLAS CORE > OPERATION" />
        <Text>Resize terminal to at least 40 columns.</Text>
        <Text dimColor>{view.status === "cancelling" ? "Waiting for safe cleanup..." : "Esc cancel safely"}</Text>
      </Box>
    );
  }

  const headerRows = 1 + wrappedRows(detail, columns);
  const viewportRows = rows - headerRows - wrappedRows(footer, columns) - 2;
  if (viewportRows < 1) {
    const lines = lifecycleOperationLines(view, columns).slice(-Math.max(1, rows - 3));
    return (
      <Box flexDirection="column" width={columns}>
        <Header title="ATLAS CORE > OPERATION" />
        {lines.map((line, index) => (
          <Text
            {...(line.color ? { color: line.color } : {})}
            {...(line.dim === undefined ? {} : { dimColor: line.dim })}
            key={`${index}-${line.text}`}
          >
            {line.text || " "}
          </Text>
        ))}
        <Text dimColor={view.status !== "failure"}>{footer}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={columns}>
      <Header right={detail} title="ATLAS CORE > OPERATION" />
      <Rule width={columns} />
      <Box flexDirection="column" height={viewportRows} justifyContent="flex-end">
        {lifecycleOperationLines(view, columns)
          .slice(-viewportRows)
          .map((line, index) => (
            <Text
              {...(line.color ? { color: line.color } : {})}
              {...(line.dim === undefined ? {} : { dimColor: line.dim })}
              key={`${index}-${line.text}`}
            >
              {line.text || " "}
            </Text>
          ))}
      </Box>
      <Rule width={columns} />
      <Text dimColor={view.status !== "failure"}>{footer}</Text>
    </Box>
  );
}

function UpdateOperationScreen({
  onBack,
  onCancel,
  returnToMenu,
  view
}: {
  onBack(): void;
  onCancel(disposition: "return" | "exit"): void;
  returnToMenu: boolean;
  view: UpdateOperationView;
}): ReactNode {
  const { columns, rows } = useWindowSize();
  const [now, setNow] = useState(Date.now());
  const finished = view.status === "success" || view.status === "failure" || view.status === "cancelled";

  useEffect(() => {
    if (finished) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [finished]);

  useInput((input, key) => {
    if (!finished && key.escape) {
      onCancel("return");
      return;
    }
    if (!finished && key.ctrl && input === "c") {
      onCancel("exit");
      return;
    }
    if (finished && (key.return || key.escape || (key.ctrl && input === "c"))) onBack();
  });

  const elapsed = (view.completedAt ?? now) - view.startedAt;
  const detail = `${updateScopeLabel(view.info, view.scope)} update  ${formatActivityTime(elapsed)}`;
  const footer = finished
    ? returnToMenu
      ? "Enter return to Atlas Core"
      : "Enter exit"
    : view.status === "cancelling"
      ? "Cancelling safely. Waiting for cleanup..."
      : "Esc cancel and return   Ctrl+C cancel and exit";
  if (columns < MINIMUM_TERMINAL_COLUMNS) {
    return (
      <Box flexDirection="column" width={columns}>
        <Header title="ATLAS CORE > UPDATE" />
        <Text>Resize terminal to at least 40 columns.</Text>
        <Text dimColor>
          {view.status === "cancelling" ? "Waiting for safe cleanup..." : "Esc return   Ctrl+C cancel and exit"}
        </Text>
      </Box>
    );
  }

  const headerRows = 1 + wrappedRows(detail, columns);
  const viewportRows = rows - headerRows - wrappedRows(footer, columns) - 2;
  if (viewportRows < 1) {
    const lines = updateOperationLines(view, columns).slice(-Math.max(1, rows - 3));
    return (
      <Box flexDirection="column" width={columns}>
        <Header title="ATLAS CORE > UPDATE" />
        {lines.map((line, index) => (
          <Text
            {...(line.color ? { color: line.color } : {})}
            {...(line.dim === undefined ? {} : { dimColor: line.dim })}
            key={`${index}-${line.text}`}
          >
            {line.text || " "}
          </Text>
        ))}
        <Text dimColor={view.status !== "failure"}>{footer}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={columns}>
      <Header right={detail} title="ATLAS CORE > UPDATE" />
      <Rule width={columns} />
      <Box flexDirection="column" height={viewportRows} justifyContent="flex-end">
        {updateOperationLines(view, columns)
          .slice(-viewportRows)
          .map((line, index) => (
            <Text
              {...(line.color ? { color: line.color } : {})}
              {...(line.dim === undefined ? {} : { dimColor: line.dim })}
              key={`${index}-${line.text}`}
            >
              {line.text || " "}
            </Text>
          ))}
      </Box>
      <Rule width={columns} />
      <Text dimColor={view.status !== "failure"}>{footer}</Text>
    </Box>
  );
}

function appendUpdateEvent(
  events: UpdateOperationEvent[],
  progress: UpdateProgress,
  elapsedMs: number
): UpdateOperationEvent[] {
  const truncatedSuffix = " [truncated]";
  const message =
    progress.message.length > MAX_UPDATE_EVENT_MESSAGE_LENGTH
      ? `${progress.message.slice(0, MAX_UPDATE_EVENT_MESSAGE_LENGTH - truncatedSuffix.length)}${truncatedSuffix}`
      : progress.message;
  return [
    ...events.slice(-(MAX_UPDATE_EVENTS - 1)),
    {
      ...progress,
      elapsedMs,
      message
    }
  ];
}

function updateOperationLines(view: UpdateOperationView, width: number): ActivityLine[] {
  const lines = view.events.flatMap((event) => {
    const marker = event.stage === "cleanup" ? "[cleanup]" : "[work]";
    const prefix = `${formatActivityTime(event.elapsedMs)} ${marker} `;
    return wrapAnsi(`${prefix}${event.message}`, width, { hard: true, trim: false })
      .split("\n")
      .map((text) => ({ dim: event.stage === "operation", text }));
  });
  if (view.status === "success") {
    const successText =
      view.scope === "cli"
        ? `Update complete. Atlas Core CLI ${view.info.latestVersion} installed. Running Core and durable data were not changed.`
        : !view.info.cliUpdateAvailable
          ? `Update complete. Atlas Core deployment ${view.info.latestVersion} is current.`
          : `Update complete. Atlas Core CLI ${view.info.latestVersion} and the Core deployment are current.`;
    return [...lines, { text: "" }, { color: "green", text: successText }];
  }
  if (view.status === "cancelled") {
    const cancellationText =
      view.scope === "cli"
        ? "CLI update cancelled. Running Core and durable data were not changed; the package may have updated."
        : !view.info.cliUpdateAvailable
          ? "Core-only update cancelled. Running Core and durable data were not deleted."
          : "Update cancelled. Running Core and durable data were not deleted; the package may have updated.";
    return [...lines, { text: "" }, { color: "yellow", text: cancellationText }];
  }
  if (view.status === "failure") {
    const coreUpdateStarted = view.events.some((event) => event.phase === "core");
    const recoveryText =
      view.scope === "cli"
        ? "Resolve the CLI package or supervision error before retrying the CLI update."
        : view.info.cliUpdateAvailable && !coreUpdateStarted
          ? "Resolve the CLI package or supervision error before retrying the combined update."
          : !view.info.cliUpdateAvailable
            ? "Inspect Core recovery status before retrying the Core update."
            : "CLI installation may have completed; inspect recovery status before retrying.";
    return [
      ...lines,
      { text: "" },
      {
        color: "red",
        text: `ERROR: ${view.error ?? "Update failed."} The update stopped without deleting Atlas Core data. ${recoveryText}`
      }
    ];
  }
  return lines;
}

function lifecycleOperationLines(view: LifecycleOperationView, width: number): ActivityLine[] {
  const lines = view.events.flatMap((event) => {
    const marker = event.stage === "cleanup" ? "[cleanup]" : "[work]";
    const prefix = `${formatActivityTime(event.elapsedMs)} ${marker} `;
    return wrapAnsi(`${prefix}${event.message}`, width, { hard: true, trim: false })
      .split("\n")
      .map((text) => ({ dim: event.stage === "operation", text }));
  });
  const summary = lifecycleOperationSummaryLine(view);
  return summary ? [...lines, { text: "" }, ...activityMessageLines(summary, width)] : lines;
}

function lifecycleOperationSummaryLine(view: LifecycleOperationView): ActivityLine | undefined {
  if (view.status === "success")
    return { color: "green", text: view.summary ?? lifecycleOperationSummary(view.operation) };
  if (view.status === "cancelled")
    return { color: "yellow", text: view.summary ?? `${lifecycleOperationLabel(view.operation)} cancelled.` };
  if (view.status !== "failure") return undefined;
  const lines: string[] = [view.error ? `ERROR: ${view.error}` : `${lifecycleOperationLabel(view.operation)} failed.`];
  if (view.snapshot) {
    const label = lifecycleSnapshotStatus(view.snapshot.status);
    lines.push(`Deployment state: ${label}. ${view.snapshot.detail}`);
  }
  lines.push(lifecycleRecoveryHint(view));
  return { color: "red", text: lines.join(" ") };
}

function lifecycleRecoveryHint(view: LifecycleOperationView): string {
  const error = view.error ?? "";
  if (/recovery remains pending|must finish disabling|pending/i.test(error)) {
    return "Finish the pending recovery or Plugin disable, then retry the operation.";
  }
  if (/deployment mutation is locked|mutation lock/i.test(error)) {
    return "Wait for the active mutation to finish, then retry the operation.";
  }
  if (/supervision/i.test(error)) {
    return "Install recovery supervision, or rerun this operation with its explicit manual command.";
  }
  if (view.snapshot?.status === "stopped") {
    if (view.operation === "configure") return "Retry the admin password change while Atlas Core is stopped.";
    return view.operation === "restart"
      ? "Restart is unavailable while stopped. Choose Start Atlas Core."
      : "Choose Start Atlas Core to retry the operation.";
  }
  if (view.snapshot?.status === "degraded") return "Review service health, then retry the operation when it is safe.";
  if (view.snapshot?.status === "ready" && view.operation === "stop") {
    return "Services are still running. Retry Stop Atlas Core when it is safe.";
  }
  return "Review service health, then retry the operation.";
}

function lifecycleSnapshotStatus(status: DeploymentSnapshot["status"]): string {
  return status === "ready"
    ? "Running"
    : status === "stopped"
      ? "Stopped"
      : status === "degraded"
        ? "Degraded"
        : status === "initializing"
          ? "Initializing"
          : "Not initialized";
}

function PluginsMenu({
  onBack,
  onInstall,
  onLogs,
  onToggle,
  onUpdate,
  view
}: {
  onBack(): void;
  onInstall: ((plugin: PluginDeploymentStatus) => void) | undefined;
  onLogs(plugin: PluginDeploymentStatus): void;
  onToggle(plugin: PluginDeploymentStatus): void;
  onUpdate: ((plugin: PluginDeploymentStatus) => void) | undefined;
  view: PluginDeploymentStatus[] | Error;
}): ReactNode {
  const { columns, rows } = useWindowSize();
  const actionPending = useRef(false);
  const selectedRef = useRef(0);
  const [selected, setSelected] = useState(0);
  const plugins = view instanceof Error ? [] : view;
  const index = Math.min(selected, Math.max(0, plugins.length - 1));
  const plugin = plugins[index];
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS && rows >= MINIMUM_TERMINAL_ROWS;
  const footer =
    plugins.length > 0
      ? `↑/↓ ${index + 1}/${plugins.length}   Enter install/enable/disable${plugin?.installed === true && onUpdate ? "   u update" : ""}   l logs   Esc back`
      : "Esc back";
  const revocationSummary = plugin?.revoked
    ? firstTerminalLine(`REVOKED${plugin.revocationReason ? `: ${plugin.revocationReason}` : ""}`, columns)
    : undefined;
  const errorSummary = plugin?.error ? firstTerminalLine(`ERROR: ${plugin.error}`, columns) : undefined;
  const chromeRows =
    7 +
    Number(plugin?.installed === true) +
    Number(Boolean(plugin?.updatePlan)) +
    Number(Boolean(revocationSummary)) +
    Number(Boolean(errorSummary));
  const viewportRows = Math.max(1, rows - chromeRows - wrappedRows(footer, columns));
  const firstPlugin = Math.max(
    0,
    Math.min(index - Math.floor(viewportRows / 2), Math.max(0, plugins.length - viewportRows))
  );
  const visiblePlugins = plugins.slice(firstPlugin, firstPlugin + viewportRows);
  useInput((input, key) => {
    if (actionPending.current) return;
    const modified = hasCommandModifier(key);
    if (key.escape || (key.ctrl && input === "c") || (!modified && input === "q")) {
      actionPending.current = true;
      onBack();
    } else if (!canInteract || modified) return;
    else if (key.upArrow && plugins.length > 0) {
      const next = (Math.min(selectedRef.current, plugins.length - 1) - 1 + plugins.length) % plugins.length;
      selectedRef.current = next;
      setSelected(next);
    } else if (key.downArrow && plugins.length > 0) {
      const next = (Math.min(selectedRef.current, plugins.length - 1) + 1) % plugins.length;
      selectedRef.current = next;
      setSelected(next);
    } else if (key.return && plugin?.installed === false && onInstall) {
      actionPending.current = true;
      onInstall(plugin);
    } else if (key.return && plugin && (plugin.packaged || plugin.installed === true)) {
      actionPending.current = true;
      onToggle(plugin);
    } else if (input === "u" && plugin?.installed === true && onUpdate) {
      actionPending.current = true;
      onUpdate(plugin);
    } else if (input === "l" && plugin?.enabled) {
      actionPending.current = true;
      onLogs(plugin);
    }
  });
  if (columns < MINIMUM_TERMINAL_COLUMNS) return <NarrowTerminal />;
  if (rows < MINIMUM_TERMINAL_ROWS) {
    return (
      <Box flexDirection="column" width={columns}>
        <Header title="ATLAS CORE > PLUGINS" />
        <Text>Resize terminal to at least 24 rows.</Text>
        <Text dimColor>Esc returns without changing Plugins.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" width={columns}>
      <Header title="ATLAS CORE > PLUGINS" />
      <Text> </Text>
      {view instanceof Error ? (
        <Text color="red">{view.message}</Text>
      ) : plugins.length === 0 ? (
        <Text>
          No Plugins are installed or available from the verified catalog. Run atlas-core plugins refresh to load it.
        </Text>
      ) : (
        <>
          <Text bold>PLUGIN CATALOG</Text>
          {visiblePlugins.map((candidate, visibleIndex) => {
            const candidateIndex = firstPlugin + visibleIndex;
            const runtime = candidate.state ? `  ${candidate.state}/${candidate.health || "unknown"}` : "";
            const availability =
              candidate.installed === false
                ? "  not installed"
                : candidate.packaged || candidate.installed === true
                  ? ""
                  : "  image unavailable";
            const error = candidate.error ? "  ERROR" : "";
            const revocation = candidate.revoked
              ? `  REVOKED${candidate.revocationReason ? `: ${candidate.revocationReason}` : ""}`
              : "";
            return (
              <Text inverse={candidateIndex === index} key={candidate.pluginId}>
                {pad(
                  `${candidateIndex === index ? ">" : " "} ${candidate.displayName}  ${candidate.enabled ? "enabled" : "disabled"}${runtime}${availability}${error}${revocation}`,
                  columns
                )}
              </Text>
            );
          })}
          <Text> </Text>
          <Text>{firstTerminalLine(plugin?.pluginId ?? "", columns)}</Text>
          <Text dimColor>{plugin?.lifecycle === "query_only" ? "Query-only, stateless" : "Unsupported lifecycle"}</Text>
          {plugin?.installed === true ? <Text>{`Selected  ${plugin.selectedVersion ?? "Unknown"}`}</Text> : null}
          {plugin?.updatePlan ? <Text>{`Catalog   ${pluginCatalogAvailability(plugin.updatePlan)}`}</Text> : null}
          {revocationSummary ? <Text color="red">{revocationSummary}</Text> : null}
          {errorSummary ? <Text color="red">{errorSummary}</Text> : null}
        </>
      )}
      <Rule width={columns} />
      <Text dimColor>{footer}</Text>
    </Box>
  );
}

function PluginUpdateReview({
  onBack,
  onConfirm,
  plan
}: {
  onBack(): void;
  onConfirm: (() => void) | undefined;
  plan: PluginUpdatePlan;
}): ReactNode {
  const { columns } = useWindowSize();
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS;
  const actionPending = useRef(false);
  useInput((input, key) => {
    if (actionPending.current) return;
    if (key.escape || (key.ctrl && input === "c") || input === "q") {
      actionPending.current = true;
      onBack();
    } else if (!canInteract) {
      return;
    } else if (key.return && onConfirm) {
      actionPending.current = true;
      onConfirm();
    }
  });
  if (!canInteract) return <NarrowTerminal />;
  const title =
    "action" in plan && plan.action === "replacement"
      ? "ATLAS CORE > REVIEW PLUGIN REPLACEMENT"
      : "ATLAS CORE > REVIEW PLUGIN UPDATE";
  const values: KeyValue[] = [
    ["Plugin", `${plan.displayName} (${plan.pluginId})`],
    ["Current", plan.currentVersion],
    ...("targetVersion" in plan && plan.targetVersion ? ([["Target", plan.targetVersion]] as const) : []),
    ["State", plan.enabled ? "Enabled" : "Disabled"],
    ["Core", `${plan.coreVersion} remains installed`],
    ["Core image", `${plan.coreImage} remains unchanged`],
    ["May restart", plan.restartServices.length > 0 ? plan.restartServices.join(", ") : "No running Atlas services"]
  ];
  const message =
    plan.status === "available"
      ? plan.action === "replacement"
        ? "The selected release is revoked. Atlas will install this permitted replacement."
        : "Atlas will update this Plugin without installing a new Atlas Core version."
      : plan.reason;
  return (
    <Box flexDirection="column" width={columns}>
      <Header title={title} />
      <Text> </Text>
      <KeyValues values={values} width={columns} />
      <Text> </Text>
      <Text
        {...(plan.status === "blocked" ? { color: "red" as const } : {})}
        {...(plan.status === "current" ? { color: "green" as const } : {})}
      >
        {message}
      </Text>
      <Rule width={columns} />
      <Text dimColor>{onConfirm ? "Enter confirm   Esc cancel" : "Esc return to Plugins"}</Text>
    </Box>
  );
}

function pluginCatalogAvailability(plan: PluginUpdatePlan): string {
  if (plan.status === "available" || (plan.status === "blocked" && plan.targetVersion)) {
    return `${plan.targetVersion} compatible ${plan.action === "replacement" ? "replacement" : "update"}`;
  }
  if (plan.status === "current") return "Current; no compatible replacement";
  if (/incompatible|no compatible/iu.test(plan.reason)) return "No compatible replacement";
  return "Availability unavailable";
}

function SimpleMenu({
  choices,
  onBack,
  onSelect,
  title
}: {
  choices: string[];
  onBack(): void;
  onSelect(index: number): void;
  title: string;
}): ReactNode {
  const { columns } = useWindowSize();
  const actionPending = useRef(false);
  const selectedRef = useRef(0);
  const [selected, setSelected] = useState(0);
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS;
  useInput((input, key) => {
    if (actionPending.current) return;
    if (key.escape || (key.ctrl && input === "c")) {
      actionPending.current = true;
      onBack();
    } else if (!canInteract || hasCommandModifier(key)) return;
    else if (key.upArrow) {
      const next = (selectedRef.current - 1 + choices.length) % choices.length;
      selectedRef.current = next;
      setSelected(next);
    } else if (key.downArrow) {
      const next = (selectedRef.current + 1) % choices.length;
      selectedRef.current = next;
      setSelected(next);
    } else if (key.return) {
      actionPending.current = true;
      onSelect(selectedRef.current);
    }
  });
  if (!canInteract) return <NarrowTerminal />;
  return (
    <Box flexDirection="column" width={columns}>
      <Header title={title} />
      <Text> </Text>
      {choices.map((choice, index) => (
        <Text inverse={index === selected} key={choice}>
          {pad(`${index === selected ? ">" : " "} ${choice}`, columns)}
        </Text>
      ))}
      <Text> </Text>
      <Text dimColor>{"↑/↓ move   Enter select   Esc back"}</Text>
    </Box>
  );
}

function PasswordScreen({
  error: initialError,
  onCancel,
  onSubmit
}: {
  error?: string;
  onCancel(): void;
  onSubmit(password: string): void;
}): ReactNode {
  const { columns } = useWindowSize();
  const actionPending = useRef(false);
  const confirmationRef = useRef(false);
  const passwordRef = useRef("");
  const valueRef = useRef("");
  const [confirmation, setConfirmation] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);
  const [value, setValue] = useState("");
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS;

  const submit = (): void => {
    if (!confirmationRef.current) {
      passwordRef.current = valueRef.current;
      valueRef.current = "";
      setValue("");
      confirmationRef.current = true;
      setConfirmation(true);
      setError(undefined);
      return;
    }
    if (valueRef.current !== passwordRef.current) {
      setError("Passwords did not match. The admin password was not changed.");
      passwordRef.current = "";
      valueRef.current = "";
      setValue("");
      confirmationRef.current = false;
      setConfirmation(false);
      return;
    }
    actionPending.current = true;
    onSubmit(passwordRef.current);
  };

  useInput((input, key) => {
    if (actionPending.current) return;
    if (key.escape || (key.ctrl && input === "c")) {
      actionPending.current = true;
      onCancel();
    } else if (!canInteract || hasCommandModifier(key)) return;
    else if (key.return) submit();
    else if (key.backspace || key.delete) {
      const next = Array.from(valueRef.current).slice(0, -1).join("");
      valueRef.current = next;
      setValue(next);
    } else if (isPrintableInput(input, key)) {
      valueRef.current += input;
      setValue(valueRef.current);
    }
  });
  usePaste(
    (pasted) => {
      if (actionPending.current) return;
      valueRef.current += printableText(pasted);
      setValue(valueRef.current);
    },
    { isActive: canInteract }
  );

  if (!canInteract) return <NarrowTerminal />;
  return (
    <Box flexDirection="column" width={columns}>
      <Header title="Configure > Admin account" />
      <Text>Username: admin</Text>
      <Text> </Text>
      {error ? <Text color="red">{error}</Text> : null}
      <Box>
        <Text>{confirmation ? "Confirm password: " : "New password:     "}</Text>
        <Text>{"*".repeat(Array.from(value).length)}</Text>
      </Box>
      <Text> </Text>
      <Text dimColor>{"Enter continue   Esc cancel"}</Text>
    </Box>
  );
}

function UpdateMenu({
  info,
  onBack,
  onReload,
  onReview
}: {
  info: UpdateInfo;
  onBack(): void;
  onReload(): void;
  onReview(scope: UpdateScope): void;
}): ReactNode {
  const { columns } = useWindowSize();
  const actionPending = useRef(false);
  const selectedRef = useRef(0);
  const choices = useMemo(() => updateChoices(info), [info]);
  const [selected, setSelected] = useState(0);
  const selectedIndex = Math.min(selected, Math.max(0, choices.length - 1));
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS;
  useInput((input, key) => {
    if (actionPending.current) return;
    const modified = hasCommandModifier(key);
    if (key.escape || (key.ctrl && input === "c") || (!modified && input === "q")) {
      actionPending.current = true;
      onBack();
    } else if (!canInteract || modified) return;
    else if (input === "r") {
      actionPending.current = true;
      onReload();
    } else if (key.upArrow && choices.length > 0) {
      const next = (Math.min(selectedRef.current, choices.length - 1) - 1 + choices.length) % choices.length;
      selectedRef.current = next;
      setSelected(next);
    } else if (key.downArrow && choices.length > 0) {
      const next = (Math.min(selectedRef.current, choices.length - 1) + 1) % choices.length;
      selectedRef.current = next;
      setSelected(next);
    } else if (key.return) {
      const choice = choices[Math.min(selectedRef.current, Math.max(0, choices.length - 1))];
      actionPending.current = true;
      if (choice) onReview(choice.scope);
      else onBack();
    }
  });

  if (!canInteract) return <NarrowTerminal />;
  const choice = choices[selectedIndex];
  return (
    <Box flexDirection="column" width={columns}>
      <Header title="ATLAS CORE > UPDATE" />
      <Text> </Text>
      <KeyValues
        values={[
          ["Installed CLI", info.cliVersion],
          ["Running Core", info.coreVersion ?? "Not initialized"],
          ["Latest release", info.latestVersion]
        ]}
        width={columns}
      />
      <Text> </Text>
      {choices.length === 0 ? (
        <Text>The CLI and Atlas Core are current.</Text>
      ) : (
        <>
          <Text bold>CHOOSE UPDATE</Text>
          {choices.map((candidate, index) => (
            <Text inverse={index === selectedIndex} key={candidate.scope}>
              {pad(`${index === selectedIndex ? ">" : " "} ${candidate.label}`, columns)}
            </Text>
          ))}
          <Text> </Text>
          <Text>
            {choice?.scope === "cli"
              ? "CLI-only: install the latest CLI while leaving Atlas Core, credentials, and durable data unchanged."
              : info.cliUpdateAvailable
                ? "Preserve credentials and durable data, install the latest CLI, then return Atlas Core to its prior running or stopped state on the reviewed image."
                : "Preserve credentials and durable data, update Atlas Core, then return Atlas Core to its prior running or stopped state."}
          </Text>
        </>
      )}
      <Rule width={columns} />
      <Text dimColor>
        {choices.length === 0
          ? "r check again   Enter or Esc back"
          : "↑/↓ move   Enter review   r check again   Esc back"}
      </Text>
    </Box>
  );
}

function UpdateReview({
  info,
  onApply,
  onBack,
  scope
}: {
  info: UpdateInfo;
  onApply(): void;
  onBack(): void;
  scope: UpdateScope;
}): ReactNode {
  const { columns, rows } = useWindowSize();
  const actionPending = useRef(false);
  const requiredRows = updateReviewRows(info, scope, columns);
  const hasEnoughRows = rows >= requiredRows;
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS && hasEnoughRows;
  useInput((input, key) => {
    if (actionPending.current) return;
    if (key.escape || (key.ctrl && input === "c")) {
      actionPending.current = true;
      onBack();
    } else if (!canInteract || hasCommandModifier(key)) return;
    else if (key.return) {
      actionPending.current = true;
      onApply();
    }
  });
  if (columns < MINIMUM_TERMINAL_COLUMNS) return <NarrowTerminal />;
  if (!hasEnoughRows) return <ShortUpdateReview requiredRows={requiredRows} />;
  return (
    <Box flexDirection="column" width={columns}>
      <Header title="REVIEW UPDATE" />
      <Text> </Text>
      {scope === "cli" ? (
        <>
          <Text>
            CLI {info.cliVersion} → {info.latestVersion}
          </Text>
          <Text>Atlas Core stays at {info.coreVersion ?? "not initialized"}.</Text>
          <Text>CLI-only scope: running Core, credentials, and durable data stay unchanged.</Text>
          <Text> </Text>
          <Text>The current process exits after npm installs the CLI.</Text>
        </>
      ) : (
        <>
          <Text>
            {info.cliUpdateAvailable
              ? `CLI ${info.cliVersion} → ${info.latestVersion}`
              : `CLI stays at ${info.cliVersion}.`}
          </Text>
          <Text>
            Atlas Core {info.coreVersion} → {info.latestVersion}
          </Text>
          <Text> </Text>
          <Text>{CORE_UPDATE_REVIEW_COPY}</Text>
        </>
      )}
      <Rule width={columns} />
      <Text dimColor>{"Enter update   Esc back"}</Text>
    </Box>
  );
}

function MessageScreen({ message, onBack, title }: { message: string; onBack(): void; title: string }): ReactNode {
  const { columns } = useWindowSize();
  const actionPending = useRef(false);
  useInput((input, key) => {
    if (actionPending.current) return;
    if (key.return || key.escape || (key.ctrl && input === "c")) {
      actionPending.current = true;
      onBack();
    }
  });
  if (columns < MINIMUM_TERMINAL_COLUMNS) return <NarrowTerminal />;
  return (
    <Box flexDirection="column" width={columns}>
      <Header title={title} />
      <Text> </Text>
      <Text color="red">{message}</Text>
      <Rule width={columns} />
      <Text dimColor>Enter or Esc back</Text>
    </Box>
  );
}

function BusyScreen({ label, onCancel }: { label: string; onCancel(): void }): ReactNode {
  const { exit } = useApp();
  const { columns } = useWindowSize();
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      exit();
    }
  });
  if (columns < MINIMUM_TERMINAL_COLUMNS) return <NarrowTerminal />;
  return (
    <Box flexDirection="column" width={columns}>
      <Header title="ATLAS CORE" />
      <Text> </Text>
      <Text>{label}</Text>
    </Box>
  );
}

function Header({ right, title }: { right?: string; title: string }): ReactNode {
  return (
    <Box justifyContent="space-between">
      <Text bold color="cyan">
        {title}
      </Text>
      {right ? <Text dimColor>{right}</Text> : null}
    </Box>
  );
}

function Rule({ width }: { width: number }): ReactNode {
  return <Text dimColor>{"─".repeat(Math.max(1, width))}</Text>;
}

function NarrowTerminal(): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        ATLAS CORE
      </Text>
      <Text>Terminal too narrow.</Text>
      <Text dimColor>Resize to at least 40 columns.</Text>
    </Box>
  );
}

function ShortStatusTerminal({ requiredRows }: { requiredRows: number }): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        ATLAS CORE
      </Text>
      <Text>Status needs at least {requiredRows} rows at this width.</Text>
      <Text dimColor>Resize the terminal or press Enter or Esc to go back.</Text>
    </Box>
  );
}

function ShortUpdateReview({ requiredRows }: { requiredRows: number }): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        ATLAS CORE
      </Text>
      <Text>Update review needs at least {requiredRows} rows at this width.</Text>
      <Text dimColor>Resize the terminal or press Esc to go back.</Text>
    </Box>
  );
}

function updateReviewRows(info: UpdateInfo, scope: UpdateScope, width: number): number {
  const headerAndFooterRows =
    wrappedRows("REVIEW UPDATE", width) + 1 + 1 + wrappedRows("Enter update   Esc back", width);
  if (scope === "cli") {
    return (
      headerAndFooterRows +
      wrappedRows(`CLI ${info.cliVersion} → ${info.latestVersion}`, width) +
      wrappedRows(`Atlas Core stays at ${info.coreVersion ?? "not initialized"}.`, width) +
      wrappedRows("CLI-only scope: running Core, credentials, and durable data stay unchanged.", width) +
      1 +
      wrappedRows("The current process exits after npm installs the CLI.", width)
    );
  }
  return (
    headerAndFooterRows +
    wrappedRows(
      info.cliUpdateAvailable ? `CLI ${info.cliVersion} → ${info.latestVersion}` : `CLI stays at ${info.cliVersion}.`,
      width
    ) +
    wrappedRows(`Atlas Core ${info.coreVersion} → ${info.latestVersion}`, width) +
    1 +
    wrappedRows(CORE_UPDATE_REVIEW_COPY, width)
  );
}

function updateChoices(info: UpdateInfo): Array<{ label: string; scope: UpdateScope }> {
  const choices: Array<{ label: string; scope: UpdateScope }> = [];
  if (info.cliUpdateAvailable) choices.push({ label: "Update CLI only", scope: "cli" });
  if (info.coreVersion && (info.cliUpdateAvailable || info.coreUpdateAvailable)) {
    choices.push({
      label: info.cliUpdateAvailable ? "Update CLI + Atlas Core" : "Update Atlas Core",
      scope: "all"
    });
  }
  return choices;
}

function updateInvolvesCLI(info: UpdateInfo, scope: UpdateScope): boolean {
  return scope === "cli" || (scope === "all" && info.cliUpdateAvailable);
}

function updateScopeLabel(info: UpdateInfo, scope: UpdateScope): "CLI-only" | "Core-only" | "CLI + Core" {
  if (scope === "cli") return "CLI-only";
  return info.cliUpdateAvailable ? "CLI + Core" : "Core-only";
}

async function readSnapshot(operator: AtlasCoreOperator): Promise<DeploymentSnapshot> {
  try {
    return await operator.snapshot();
  } catch (error) {
    return { status: "degraded", canReset: false, detail: errorMessage(error) };
  }
}

async function runCancelableOperation<T>(
  operator: AtlasCoreOperator,
  operation: () => Promise<T>
): Promise<OperationResult<T>> {
  // Keep Ctrl-C cancellation consistent for both terminal input and process signals.
  let cancelled = false;
  const onInterrupt = (): void => {
    if (cancelled) return;
    cancelled = true;
    operator.cancelPending();
  };
  process.on("SIGINT", onInterrupt);
  try {
    const value = await operation();
    return { cancelled, value };
  } catch (error) {
    return error instanceof CommandCancelledError
      ? { cancelled: true }
      : { cancelled, failure: new Error(errorMessage(error)) };
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

function assertInteractive(input: NodeJS.ReadStream, output: NodeJS.WriteStream): void {
  if (input.isTTY !== true || output.isTTY !== true || input.setRawMode === undefined) {
    throw new Error("Atlas Core's menu requires an interactive terminal. Use atlas-core help to list commands.");
  }
}

function initialLoadingLabel(mode: AppMode): string {
  if (mode === "update") return "Checking npm for the latest release...";
  if (mode === "configure") return "Opening admin account configuration...";
  return "Checking deployment...";
}

function stateName(status: DeploymentSnapshot["status"]): string {
  return status.replace("not-initialized", "NOT INITIALIZED").toUpperCase();
}

function joinMetric(value: string | undefined, percentage: string | undefined): string {
  if (!value) return "Not available";
  return percentage ? `${value} (${percentage})` : value;
}

function pad(value: string, width: number): string {
  const clipped = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
  return clipped.padEnd(width);
}

function isPrintableInput(input: string, key: Key): boolean {
  return !hasCommandModifier(key) && /^[^\u0000-\u001f\u007f]+$/u.test(input);
}

function hasCommandModifier(key: Key): boolean {
  return key.ctrl || key.meta || key.super || key.hyper;
}

function printableText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lifecycleCancellationScreen(screen: Screen, message: string): Screen {
  if (screen.kind !== "operation" || screen.view.status !== "running") return screen;
  return {
    ...screen,
    view: {
      ...screen.view,
      events: [...screen.view.events, { elapsedMs: Date.now() - screen.view.startedAt, message, stage: "cleanup" }],
      status: "cancelling"
    }
  };
}

function updateCancellationScreen(screen: Screen, message: string): Screen {
  if (screen.kind !== "update-operation" || screen.view.status !== "running") return screen;
  return {
    ...screen,
    view: {
      ...screen.view,
      events: [...screen.view.events, { elapsedMs: Date.now() - screen.view.startedAt, message, stage: "cleanup" }],
      status: "cancelling"
    }
  };
}

function pluginActivityCancellationScreen(screen: Screen, message: string): Screen {
  if (screen.kind !== "plugin-activity" || screen.view.status !== "running") return screen;
  return {
    ...screen,
    view: {
      ...screen.view,
      events: [
        ...screen.view.events,
        {
          elapsedMs: Date.now() - screen.view.startedAt,
          level: "working",
          message,
          stage: "rollback"
        }
      ],
      status: "cancelling"
    }
  };
}
