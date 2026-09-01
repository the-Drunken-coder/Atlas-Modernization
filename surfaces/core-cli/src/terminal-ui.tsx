import { Box, type Key, render, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import wrapAnsi from "wrap-ansi";
import { CommandCancelledError } from "./operation-errors.js";
import { PACKAGE_VERSION } from "./package-metadata.js";

export type DeploymentSnapshot = {
  status: "degraded" | "not-initialized" | "ready" | "stopped";
  detail: string;
};

export type DeploymentService = {
  id: "api" | "minio" | "postgres" | "source-gateway";
  label: string;
  container: string;
  state: string;
  health: string;
  cpuPercent?: string;
  memoryUsage?: string;
  memoryPercent?: string;
  networkIO?: string;
  blockIO?: string;
  processes?: string;
  uptime?: string;
  restarts?: number;
  image?: string;
};

export type DeploymentDetails = {
  snapshot: DeploymentSnapshot;
  cliVersion: string;
  coreVersion: string;
  initializedAt: string;
  apiEndpoint: string;
  minioEndpoint: string;
  image?: string;
  services: DeploymentService[];
  performanceError?: string;
};

export type UpdateInfo = {
  cliVersion: string;
  coreVersion?: string;
  latestVersion: string;
  cliUpdateAvailable: boolean;
  coreUpdateAvailable: boolean;
};

export type UpdateScope = "all" | "cli";

export type PluginDeploymentStatus = {
  pluginId: string;
  displayName: string;
  lifecycle: "query_only";
  enabled: boolean;
  packaged: boolean;
  state?: string;
  health?: string;
};

export type PluginActivity = {
  level: "working" | "success" | "failure";
  message: string;
  stage: "operation" | "rollback";
};

export type PluginActivityReporter = (activity: PluginActivity) => void;

export type PluginOperationOutcome = { status: "success" } | { previousDeploymentPreserved: true; status: "cancelled" };

export type AtlasCoreOperator = {
  cancelPending(): void;
  checkForUpdates(): Promise<UpdateInfo>;
  configureAdminPassword(password: string): Promise<void>;
  details(signal?: AbortSignal): Promise<DeploymentDetails>;
  doctor(): Promise<boolean>;
  init(): Promise<void>;
  logs(service: "api" | "minio" | "postgres" | "source-gateway" | undefined, follow: boolean): Promise<void>;
  pluginDisable(pluginId: string, reportActivity?: PluginActivityReporter): Promise<PluginOperationOutcome>;
  pluginEnable(pluginId: string, reportActivity?: PluginActivityReporter): Promise<PluginOperationOutcome>;
  pluginLogs(pluginId: string, follow: boolean): Promise<void>;
  pluginStatuses(pluginId?: string): Promise<PluginDeploymentStatus[]>;
  resumeAfterCancellation(): void;
  reset(): Promise<void>;
  restart(): Promise<void>;
  snapshot(): Promise<DeploymentSnapshot>;
  start(): Promise<void>;
  status(): Promise<boolean>;
  stop(): Promise<void>;
  update(scope: UpdateScope, expectedVersion?: string, coreBackupConfirmed?: boolean): Promise<void>;
};

export type InteractiveCLI = {
  configureAdmin(operator: AtlasCoreOperator): Promise<void>;
  runMenu(operator: AtlasCoreOperator): Promise<void>;
  runUpdate(operator: AtlasCoreOperator): Promise<void>;
};

type Action = {
  id:
    | "configure"
    | "doctor"
    | "init"
    | "logs"
    | "plugins"
    | "quit"
    | "reset"
    | "restart"
    | "start"
    | "status"
    | "stop"
    | "update";
  label: string;
  detail: string;
};

type Screen =
  | { kind: "busy"; label: string }
  | { kind: "configure" }
  | { kind: "logs" }
  | { kind: "menu"; snapshot: DeploymentSnapshot }
  | { kind: "password" }
  | { kind: "plugin-activity"; view: PluginActivityView }
  | { kind: "plugins"; view: PluginDeploymentStatus[] | Error }
  | { kind: "status"; view: DeploymentDetails | Error }
  | { kind: "update"; info: UpdateInfo }
  | { kind: "update-error"; message: string }
  | { kind: "update-review"; info: UpdateInfo; scope: UpdateScope };

type AppMode = "configure" | "menu" | "update";

type OperationResult<T> = {
  cancelled: boolean;
  failure?: Error;
  value?: T;
};

type PluginActivityEvent = PluginActivity & { elapsedMs: number };

type PluginActivityView = {
  action: "Enable" | "Disable";
  completedAt?: number;
  error?: string;
  events: PluginActivityEvent[];
  operationId: number;
  plugin: PluginDeploymentStatus;
  startedAt: number;
  status: "running" | "cancelling" | "success" | "failure" | "cancelled";
};

type KeyValue = readonly [string, string];
type StatusView = DeploymentDetails | Error;

type AtlasCoreAppProps = {
  input: NodeJS.ReadStream;
  mode: AppMode;
  operator: AtlasCoreOperator;
  output: NodeJS.WriteStream;
};

const MINIMUM_TERMINAL_COLUMNS = 40;
const STATUS_REFRESH_INTERVAL_MS = 5_000;

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
  const instance = render(<AtlasCoreApp input={input} mode={mode} operator={operator} output={output} />, {
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

function AtlasCoreApp({ input, mode, operator, output }: AtlasCoreAppProps): ReactNode {
  const { exit, suspendTerminal, waitUntilRenderFlush } = useApp();
  const activePluginOperation = useRef<number | undefined>(undefined);
  const pluginCancellationRequested = useRef(false);
  const pluginOperationGeneration = useRef(0);
  const statusAbortController = useRef<AbortController | undefined>(undefined);
  const statusGeneration = useRef(0);
  const statusReadPending = useRef<Promise<StatusView> | undefined>(undefined);
  const terminalLost = useRef(false);
  const [screen, setScreen] = useState<Screen>({
    kind: "busy",
    label: initialLoadingLabel(mode)
  });

  const loadMenu = useCallback(async () => {
    setScreen({ kind: "busy", label: "Checking deployment..." });
    setScreen({ kind: "menu", snapshot: await readSnapshot(operator) });
  }, [operator]);

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
      setScreen({ kind: "plugins", view: await operator.pluginStatuses() });
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
      exit(new Error("Atlas Core lost its terminal input."));
    };
    const onError = (error: Error): void => {
      terminalLost.current = true;
      operator.cancelPending();
      exit(new Error(`Atlas Core lost its terminal input: ${error.message}`));
    };
    input.once("end", onEnd);
    input.once("error", onError);
    return () => {
      input.off("end", onEnd);
      input.off("error", onError);
    };
  }, [exit, input, operator]);

  const runVisibleOperation = useCallback(
    async (label: string, operation: () => Promise<void>): Promise<OperationResult<void>> => {
      setScreen({ kind: "busy", label: `${label}...` });
      await waitUntilRenderFlush();
      let result: OperationResult<void> = { cancelled: false };
      await suspendTerminal(async () => {
        result = await runCancelableOperation(operator, operation);
        if (terminalLost.current || (result.cancelled && !result.failure)) return;
        if (result.failure) output.write(`\n${result.failure.message}\n`);
        output.write("\nPress Enter to return to Atlas Core.");
        await waitForReturn(input);
      });
      if (result.cancelled && !terminalLost.current) operator.resumeAfterCancellation();
      return result;
    },
    [input, operator, output, suspendTerminal, waitUntilRenderFlush]
  );

  const runMainAction = useCallback(
    async (action: Action): Promise<void> => {
      if (action.id === "quit") {
        exit();
        return;
      }
      if (action.id === "configure") {
        setScreen({ kind: "configure" });
        return;
      }
      if (action.id === "logs") {
        setScreen({ kind: "logs" });
        return;
      }
      if (action.id === "plugins") {
        await loadPlugins();
        return;
      }
      if (action.id === "status") {
        await loadStatus();
        return;
      }
      if (action.id === "update") {
        await loadUpdate();
        return;
      }

      await runVisibleOperation(action.label, async () => {
        switch (action.id) {
          case "doctor":
            await operator.doctor();
            return;
          case "init":
            await operator.init();
            return;
          case "plugins":
            return;
          case "reset":
            await operator.reset();
            return;
          case "restart":
            await operator.restart();
            return;
          case "start":
            await operator.start();
            return;
          case "stop":
            await operator.stop();
            return;
          case "configure":
          case "logs":
          case "quit":
          case "status":
          case "update":
            return;
        }
      });
      await loadMenu();
    },
    [exit, loadMenu, loadPlugins, loadStatus, loadUpdate, operator, runVisibleOperation]
  );

  const togglePlugin = useCallback(
    async (plugin: PluginDeploymentStatus) => {
      const action = plugin.enabled ? "Disable" : "Enable";
      const operationId = pluginOperationGeneration.current + 1;
      pluginOperationGeneration.current = operationId;
      activePluginOperation.current = operationId;
      const startedAt = Date.now();
      pluginCancellationRequested.current = false;
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
          status: "running"
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
      const result = await runCancelableOperation(operator, async () => {
        return plugin.enabled
          ? await operator.pluginDisable(plugin.pluginId, reportActivity)
          : await operator.pluginEnable(plugin.pluginId, reportActivity);
      });
      if (activePluginOperation.current === operationId) activePluginOperation.current = undefined;
      const cancellationRequested = pluginCancellationRequested.current || result.cancelled;
      if (cancellationRequested) operator.resumeAfterCancellation();
      setScreen((current) => {
        if (current.kind !== "plugin-activity" || current.view.operationId !== operationId) return current;
        const status = result.failure
          ? "failure"
          : result.value?.status === "success"
            ? "success"
            : result.value?.status === "cancelled" || result.cancelled
              ? "cancelled"
              : "success";
        return {
          ...current,
          view: {
            ...current.view,
            completedAt: Date.now(),
            ...(status === "failure" && result.failure ? { error: result.failure.message } : {}),
            status
          }
        };
      });
    },
    [operator, waitUntilRenderFlush]
  );

  const cancelPluginActivity = useCallback(() => {
    const operationId = activePluginOperation.current;
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
  }, [operator]);

  const showPluginLogs = useCallback(
    async (plugin: PluginDeploymentStatus) => {
      await runVisibleOperation("Loading Plugin logs", async () => {
        await operator.pluginLogs(plugin.pluginId, false);
      });
      await loadPlugins();
    },
    [loadPlugins, operator, runVisibleOperation]
  );

  const showLogs = useCallback(
    async (service: "api" | "minio" | "postgres" | "source-gateway" | undefined, returnTo: "menu" | "status") => {
      await runVisibleOperation("Loading logs", async () => {
        await operator.logs(service, false);
      });
      if (returnTo === "status") await loadStatus();
      else await loadMenu();
    },
    [loadMenu, loadStatus, operator, runVisibleOperation]
  );

  const runStatusDoctor = useCallback(async () => {
    await runVisibleOperation("Running diagnostics", async () => {
      await operator.doctor();
    });
    await loadStatus();
  }, [loadStatus, operator, runVisibleOperation]);

  const configureAdmin = useCallback(
    async (password: string) => {
      const result = await runVisibleOperation("Changing admin password", async () => {
        await operator.configureAdminPassword(password);
      });
      if (result.cancelled && !result.failure) {
        setScreen({ kind: mode === "configure" ? "password" : "configure" });
        return;
      }
      if (mode === "configure") {
        if (result.failure) exit(result.failure);
        else exit();
        return;
      }
      await loadMenu();
    },
    [exit, loadMenu, mode, operator, runVisibleOperation]
  );

  const applyUpdate = useCallback(
    async (info: UpdateInfo, scope: UpdateScope) => {
      setScreen({ kind: "busy", label: "Applying reviewed update..." });
      await waitUntilRenderFlush();
      let result: OperationResult<void> = { cancelled: false };
      await suspendTerminal(async () => {
        result = await runCancelableOperation(operator, async () => {
          await operator.update(scope, info.latestVersion, scope === "all");
        });
        if (result.cancelled && !result.failure) return;
        if (result.failure) output.write(`\n${result.failure.message}\n`);
        output.write(
          result.failure
            ? "\nThe update stopped without deleting Atlas Core data. Rerun atlas-core to inspect or retry.\n"
            : "\nUpdate complete. Rerun atlas-core to use the installed CLI.\n"
        );
        output.write("\nPress Enter to exit.");
        await waitForReturn(input);
      });
      if (result.cancelled && !result.failure) exit();
      else if (result.failure) exit(result.failure);
      else exit();
    },
    [exit, input, operator, output, suspendTerminal, waitUntilRenderFlush]
  );

  if (screen.kind === "busy") {
    return <BusyScreen label={screen.label} onCancel={() => operator.cancelPending()} />;
  }
  if (screen.kind === "menu") {
    return <MainMenu onSelect={(action) => void runMainAction(action)} snapshot={screen.snapshot} />;
  }
  if (screen.kind === "configure") {
    return <ConfigureMenu onAdmin={() => setScreen({ kind: "password" })} onBack={() => void loadMenu()} />;
  }
  if (screen.kind === "password") {
    return (
      <PasswordScreen
        onCancel={() => {
          if (mode === "configure") exit();
          else setScreen({ kind: "configure" });
        }}
        onSubmit={(password) => void configureAdmin(password)}
      />
    );
  }
  if (screen.kind === "logs") {
    return <LogsMenu onBack={() => void loadMenu()} onSelect={(service) => void showLogs(service, "menu")} />;
  }
  if (screen.kind === "plugins") {
    return (
      <PluginsMenu
        onBack={() => void loadMenu()}
        onLogs={(plugin) => void showPluginLogs(plugin)}
        onReload={() => void loadPlugins()}
        onToggle={(plugin) => void togglePlugin(plugin)}
        view={screen.view}
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
        onDiagnostics={() => void runStatusDoctor()}
        onLogs={(service) => void showLogs(service, "status")}
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
      onBack={() => {
        if (mode === "update") exit();
        else void loadMenu();
      }}
      onReload={() => void loadUpdate()}
      onReview={(scope) => setScreen({ kind: "update-review", info: screen.info, scope })}
    />
  );
}

function MainMenu({ onSelect, snapshot }: { onSelect(action: Action): void; snapshot: DeploymentSnapshot }): ReactNode {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const actions = useMemo(() => menuActions(snapshot), [snapshot]);
  const actionPending = useRef(false);
  const filterRef = useRef("");
  const selectedRef = useRef(0);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const filtered = useMemo(() => filteredActions(actions, filter), [actions, filter]);
  const index = Math.min(selected, Math.max(0, filtered.length - 1));
  const width = columns;
  const wide = width >= 72;
  const actionWidth = Math.min(34, Math.max(24, Math.floor(width * 0.42)));
  const action = filtered[index];
  const compactRows = compactMainMenuRows(snapshot, filtered, filter, width);
  const fullRows = fullMainMenuRows(snapshot, filtered, action, filter, width, actionWidth, wide);
  const hasEnoughRows = rows >= compactRows;
  const canInteract = columns >= MINIMUM_TERMINAL_COLUMNS && hasEnoughRows;
  const compact = rows < fullRows;

  useInput((input, key) => {
    if (actionPending.current) return;
    const modified = hasCommandModifier(key);
    if ((key.ctrl && input === "c") || key.escape || (!modified && input === "q" && filterRef.current === "")) {
      exit();
      return;
    }
    if (!canInteract || modified) return;
    const currentFiltered = filteredActions(actions, filterRef.current);
    if (key.upArrow) {
      const next =
        currentFiltered.length === 0 ? 0 : (selectedRef.current - 1 + currentFiltered.length) % currentFiltered.length;
      selectedRef.current = next;
      setSelected(next);
      return;
    }
    if (key.downArrow) {
      const next = currentFiltered.length === 0 ? 0 : (selectedRef.current + 1) % currentFiltered.length;
      selectedRef.current = next;
      setSelected(next);
      return;
    }
    if (key.backspace || key.delete) {
      filterRef.current = Array.from(filterRef.current).slice(0, -1).join("");
      setFilter(filterRef.current);
      selectedRef.current = 0;
      setSelected(0);
      return;
    }
    if (key.return) {
      const action = currentFiltered[Math.min(selectedRef.current, Math.max(0, currentFiltered.length - 1))];
      if (action) {
        actionPending.current = true;
        onSelect(action);
      }
      return;
    }
    if (isPrintableInput(input, key)) {
      filterRef.current += input;
      setFilter(filterRef.current);
      selectedRef.current = 0;
      setSelected(0);
    }
  });
  usePaste(
    (value) => {
      if (actionPending.current) return;
      const printable = printableText(value);
      if (printable) {
        filterRef.current += printable;
        setFilter(filterRef.current);
        selectedRef.current = 0;
        setSelected(0);
      }
    },
    { isActive: canInteract }
  );

  if (columns < MINIMUM_TERMINAL_COLUMNS) return <NarrowTerminal />;
  if (!hasEnoughRows) return <ShortMainMenu requiredRows={compactRows} />;

  return (
    <Box flexDirection="column" width={width}>
      <Header right={`v${PACKAGE_VERSION}  ${stateName(snapshot.status)}`} title="ATLAS CORE" />
      <Text dimColor>Manage one durable deployment</Text>
      <Rule width={width} />
      {compact ? (
        <Box flexDirection="column">
          <Text bold>ACTIONS</Text>
          <ActionRows actions={filtered} selected={index} width={width} />
          <Text>{pad(action?.detail ?? "No actions match the filter.", width)}</Text>
        </Box>
      ) : wide ? (
        <Box>
          <Box flexDirection="column" width={actionWidth}>
            <Text bold>ACTIONS</Text>
            <ActionRows actions={filtered} selected={index} width={actionWidth} />
          </Box>
          <Box
            borderBottom={false}
            borderLeft
            borderLeftDimColor
            borderRight={false}
            borderStyle="single"
            borderTop={false}
            flexDirection="column"
            paddingLeft={1}
            width={width - actionWidth}
          >
            <Text bold>DETAILS</Text>
            <Text>{action?.label ?? "No actions match the filter."}</Text>
            <Text> </Text>
            <Text>{action?.detail ?? "Clear the filter to restore the action list."}</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text bold>ACTIONS</Text>
          <ActionRows actions={filtered} selected={index} width={width} />
          <Text> </Text>
          <Text bold>DETAILS</Text>
          <Text>{action?.detail ?? "No actions match the filter."}</Text>
        </Box>
      )}
      <Rule width={width} />
      <Box justifyContent="space-between">
        <StateText status={snapshot.status} />
        <Text dimColor>Filter: {filter || "type to filter"}</Text>
      </Box>
      {compact ? null : <Text>{snapshot.detail}</Text>}
      <Text dimColor>{"↑/↓ move   Enter select   Backspace edit   Esc or q quit"}</Text>
    </Box>
  );
}

function ActionRows({ actions, selected, width }: { actions: Action[]; selected: number; width: number }): ReactNode {
  if (actions.length === 0) return <Text dimColor>No matching actions</Text>;
  return actions.map((action, index) => (
    <Text inverse={index === selected} key={action.id}>
      {pad(`${index === selected ? ">" : " "} ${action.label}`, width)}
    </Text>
  ));
}

function compactMainMenuRows(snapshot: DeploymentSnapshot, actions: Action[], filter: string, width: number): number {
  return (
    mainMenuHeaderRows(snapshot, width) +
    actionRows(actions) +
    1 +
    1 +
    wrappedRows(`${stateName(snapshot.status)} Filter: ${filter || "type to filter"}`, width) +
    wrappedRows("↑/↓ move   Enter select   Backspace edit   Esc or q quit", width)
  );
}

function fullMainMenuRows(
  snapshot: DeploymentSnapshot,
  actions: Action[],
  action: Action | undefined,
  filter: string,
  width: number,
  actionWidth: number,
  wide: boolean
): number {
  const detail = action?.detail ?? "No actions match the filter.";
  const bodyRows = wide
    ? Math.max(
        actionRows(actions),
        1 +
          wrappedRows(action?.label ?? "No actions match the filter.", Math.max(1, width - actionWidth - 2)) +
          1 +
          wrappedRows(detail, Math.max(1, width - actionWidth - 2))
      )
    : actionRows(actions) + 2 + wrappedRows(detail, width);
  return (
    mainMenuHeaderRows(snapshot, width) +
    bodyRows +
    1 +
    wrappedRows(`${stateName(snapshot.status)} Filter: ${filter || "type to filter"}`, width) +
    wrappedRows(snapshot.detail, width) +
    wrappedRows("↑/↓ move   Enter select   Backspace edit   Esc or q quit", width)
  );
}

function mainMenuHeaderRows(snapshot: DeploymentSnapshot, width: number): number {
  return (
    wrappedRows(`ATLAS CORE v${PACKAGE_VERSION} ${stateName(snapshot.status)}`, width) +
    wrappedRows("Manage one durable deployment", width) +
    1
  );
}

function actionRows(actions: Action[]): number {
  return 1 + Math.max(1, actions.length);
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

function ConfigureMenu({ onAdmin, onBack }: { onAdmin(): void; onBack(): void }): ReactNode {
  return (
    <SimpleMenu
      choices={["Admin account", "Back"]}
      onBack={onBack}
      onSelect={(index) => (index === 0 ? onAdmin() : onBack())}
      title="Configure"
    />
  );
}

function LogsMenu({
  onBack,
  onSelect
}: {
  onBack(): void;
  onSelect(service: DeploymentService["id"] | undefined): void;
}): ReactNode {
  const choices: Array<{ label: string; service: DeploymentService["id"] | undefined }> = [
    { label: "All services", service: undefined },
    { label: "Core API", service: "api" },
    { label: "Source Gateway", service: "source-gateway" },
    { label: "PostgreSQL", service: "postgres" },
    { label: "MinIO", service: "minio" }
  ];
  return (
    <SimpleMenu
      choices={[...choices.map(({ label }) => label), "Back"]}
      onBack={onBack}
      onSelect={(index) => {
        const choice = choices[index];
        if (choice) onSelect(choice.service);
        else onBack();
      }}
      title="View logs"
    />
  );
}

function PluginActivityScreen({
  onBack,
  onCancel,
  view
}: {
  onBack(): void;
  onCancel(): void;
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
    if (!finished && key.ctrl && input === "c") {
      onCancel();
      return;
    }
    if (finished && (key.return || key.escape || (key.ctrl && input === "c"))) onBack();
  });

  if (columns < MINIMUM_TERMINAL_COLUMNS) return <NarrowTerminal />;
  const elapsed = (view.completedAt ?? now) - view.startedAt;
  const detail = `${view.action} ${view.plugin.displayName}  ${formatActivityTime(elapsed)}`;
  const wide = columns >= 72;
  const footer = finished
    ? "Enter return to Plugins"
    : view.status === "cancelling"
      ? "Cancelling safely. Waiting for cleanup..."
      : "Ctrl+C cancel safely";
  const headerRows = 1 + (wide ? 0 : wrappedRows(detail, columns));
  const viewportRows = rows - headerRows - wrappedRows(footer, columns) - 2;

  if (viewportRows < 1) {
    const compactFooter = view.status === "cancelling" ? "Waiting for safe cleanup..." : footer;
    const compactHeader = `ACTIVITY ${formatActivityTime(elapsed)}`;
    if (rows <= 1) return <Text>{compactHeader}</Text>;
    const detailRows = Math.max(0, rows - 2);
    const detailLines = activityMessageLines({ text: `${view.action} ${view.plugin.displayName}` }, columns).slice(
      0,
      detailRows
    );
    return (
      <Box flexDirection="column" width={columns}>
        <Header title={compactHeader} />
        {detailLines.map((line, index) => (
          <Text key={`${index}-${line.text}`}>{line.text}</Text>
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
    return {
      color: "green",
      text: `${view.plugin.displayName} ${view.action === "Enable" ? "enabled" : "disabled"}.`
    };
  }
  if (view.status === "cancelled") {
    return { color: "yellow", text: `${view.action} cancelled. The previous deployment is preserved.` };
  }
  if (view.status === "failure") {
    return { color: "red", text: view.error ? `${view.action} failed: ${view.error}` : `${view.action} failed.` };
  }
  return undefined;
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

function PluginsMenu({
  onBack,
  onLogs,
  onReload,
  onToggle,
  view
}: {
  onBack(): void;
  onLogs(plugin: PluginDeploymentStatus): void;
  onReload(): void;
  onToggle(plugin: PluginDeploymentStatus): void;
  view: PluginDeploymentStatus[] | Error;
}): ReactNode {
  const { columns } = useWindowSize();
  const actionPending = useRef(false);
  const selectedRef = useRef(0);
  const [selected, setSelected] = useState(0);
  const plugins = view instanceof Error ? [] : view;
  const index = Math.min(selected, Math.max(0, plugins.length - 1));
  const plugin = plugins[index];
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
    } else if (key.upArrow && plugins.length > 0) {
      const next = (Math.min(selectedRef.current, plugins.length - 1) - 1 + plugins.length) % plugins.length;
      selectedRef.current = next;
      setSelected(next);
    } else if (key.downArrow && plugins.length > 0) {
      const next = (Math.min(selectedRef.current, plugins.length - 1) + 1) % plugins.length;
      selectedRef.current = next;
      setSelected(next);
    } else if (key.return && plugin?.packaged) {
      actionPending.current = true;
      onToggle(plugin);
    } else if (input === "l" && plugin?.enabled) {
      actionPending.current = true;
      onLogs(plugin);
    }
  });
  if (columns < MINIMUM_TERMINAL_COLUMNS) return <NarrowTerminal />;
  return (
    <Box flexDirection="column" width={columns}>
      <Header title="ATLAS CORE > PLUGINS" />
      <Text> </Text>
      {view instanceof Error ? (
        <Text color="red">{view.message}</Text>
      ) : plugins.length === 0 ? (
        <Text>No first-party Plugins are included in this package.</Text>
      ) : (
        <>
          <Text bold>PLUGIN CATALOG</Text>
          {plugins.map((candidate, candidateIndex) => {
            const runtime = candidate.state ? `  ${candidate.state}/${candidate.health || "unknown"}` : "";
            const availability = candidate.packaged ? "" : "  image unavailable";
            return (
              <Text inverse={candidateIndex === index} key={candidate.pluginId}>
                {pad(
                  `${candidateIndex === index ? ">" : " "} ${candidate.displayName}  ${candidate.enabled ? "enabled" : "disabled"}${runtime}${availability}`,
                  columns
                )}
              </Text>
            );
          })}
          <Text> </Text>
          <Text>{plugin?.pluginId}</Text>
          <Text dimColor>{plugin?.lifecycle === "query_only" ? "Query-only, stateless" : "Unsupported lifecycle"}</Text>
        </>
      )}
      <Rule width={columns} />
      <Text dimColor>{"↑/↓ move   Enter enable/disable   l logs   r refresh   Esc back"}</Text>
    </Box>
  );
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

function PasswordScreen({ onCancel, onSubmit }: { onCancel(): void; onSubmit(password: string): void }): ReactNode {
  const { columns } = useWindowSize();
  const actionPending = useRef(false);
  const confirmationRef = useRef(false);
  const passwordRef = useRef("");
  const valueRef = useRef("");
  const [confirmation, setConfirmation] = useState(false);
  const [error, setError] = useState<string>();
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
              ? "Install the latest CLI and leave the running Atlas Core version unchanged."
              : "Preserve credentials and durable data, install the latest CLI, then restart Atlas Core on its reviewed image."}
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
          <Text>
            PostgreSQL, MinIO, credentials, and configuration are preserved. Atlas Core restarts after the image pull.
          </Text>
          <Text> </Text>
          <Text color="yellow">Continuing confirms that a current paired PostgreSQL and MinIO backup exists.</Text>
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

function StateText({ status }: { status: DeploymentSnapshot["status"] }): ReactNode {
  if (status === "ready")
    return (
      <Text bold color="green">
        READY
      </Text>
    );
  if (status === "degraded")
    return (
      <Text bold color="yellow">
        DEGRADED
      </Text>
    );
  if (status === "stopped") return <Text bold>STOPPED</Text>;
  return (
    <Text bold color="yellow">
      NOT INITIALIZED
    </Text>
  );
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

function ShortMainMenu({ requiredRows }: { requiredRows: number }): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        ATLAS CORE
      </Text>
      <Text>Menu needs at least {requiredRows} rows at this width.</Text>
      <Text dimColor>Resize the terminal or press Esc or q to exit.</Text>
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
    wrappedRows(
      "PostgreSQL, MinIO, credentials, and configuration are preserved. Atlas Core restarts after the image pull.",
      width
    ) +
    1 +
    wrappedRows("Continuing confirms that a current paired PostgreSQL and MinIO backup exists.", width)
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

function menuActions(snapshot: DeploymentSnapshot): Action[] {
  const actions: Action[] = [];
  if (snapshot.status === "not-initialized") {
    actions.push({
      id: "init",
      label: "Initialize Atlas Core",
      detail: "Create private credentials and provision the new durable MinIO store."
    });
    actions.push({
      id: "update",
      label: "Update",
      detail: "Check npm and update the Atlas Core CLI."
    });
  } else {
    actions.push({ id: "status", label: "View status", detail: snapshot.detail });
    if (snapshot.status === "ready") {
      actions.push({ id: "stop", label: "Stop Atlas Core", detail: "Stop containers and preserve durable storage." });
    } else {
      actions.push({ id: "start", label: "Start Atlas Core", detail: "Start the deployment from its pinned image." });
    }
    actions.push(
      { id: "restart", label: "Restart Atlas Core", detail: "Pull the pinned image, then restart the deployment." },
      {
        id: "update",
        label: "Update",
        detail: "Check npm, then update only the CLI or update the CLI and Atlas Core together."
      },
      {
        id: "configure",
        label: "Configure",
        detail: "Open Atlas Core configuration. Admin account settings are available here."
      },
      {
        id: "plugins",
        label: "Plugins",
        detail: "Enable, disable, inspect, and view logs for first-party query-only Plugins."
      },
      { id: "logs", label: "View logs", detail: "Show the latest logs for all services or one service." }
    );
  }
  actions.push(
    { id: "doctor", label: "Run diagnostics", detail: "Check the host, Docker, Compose, and local configuration." },
    {
      id: "reset",
      label: "Reset Atlas Core",
      detail: "Permanently delete Atlas Core data and credentials, then start from scratch. Confirmation is required."
    },
    { id: "quit", label: "Quit", detail: "Exit without changing the deployment." }
  );
  return actions;
}

function filteredActions(actions: Action[], filter: string): Action[] {
  const query = filter.trim().toLocaleLowerCase();
  if (!query) return actions;
  return actions.filter((action) => action.label.toLocaleLowerCase().includes(query));
}

async function readSnapshot(operator: AtlasCoreOperator): Promise<DeploymentSnapshot> {
  try {
    return await operator.snapshot();
  } catch (error) {
    return { status: "degraded", detail: errorMessage(error) };
  }
}

async function waitForReturn(input: NodeJS.ReadStream): Promise<void> {
  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
    };
    const onData = (data: string | Buffer): void => {
      if (!/[\r\n]/u.test(data.toString())) return;
      cleanup();
      resolve();
    };
    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      resolve();
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.resume();
  });
}

async function runCancelableOperation<T>(
  operator: AtlasCoreOperator,
  operation: () => Promise<T>
): Promise<OperationResult<T>> {
  // Ink pauses its input hooks while the terminal is suspended, so Ctrl-C arrives as SIGINT here.
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
