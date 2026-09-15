import type {
  AtlasCoreOperator,
  DeploymentService,
  DeploymentSnapshot,
  DiagnosticsResult,
  LifecycleOperation,
  LifecycleOperationOptions,
  LifecycleOperationProgress,
  LifecycleOperationResult,
  LogStream,
  PluginActivityReporter,
  PluginOperationOutcome,
  UpdateReporter,
  UpdateScope
} from "./operator.js";
import { lifecycleOperationLabel, lifecycleOperationSummary } from "./operator.js";
import { PLUGIN_CATALOG, type PluginCatalogEntry } from "./plugin-catalog.js";

type PreviewState = Exclude<DeploymentSnapshot["status"], "initializing">;
type PreviewOutput = { write(data: string): unknown };
type PreviewOptions = { lifecycleStepDelayMs?: number; pluginStepDelayMs?: number };
type PreviewInstalledPlugin = { selectedVersion: string; previousVersion: string | null };

const PREVIEW_PLUGIN_VERSIONS = ["0.2.0", "0.1.0"] as const;
const PREVIEW_CATALOG: readonly PluginCatalogEntry[] =
  PLUGIN_CATALOG.length > 0
    ? PLUGIN_CATALOG
    : [
        {
          pluginId: "demo_plugin",
          displayName: "Demo Plugin",
          lifecycle: "query_only",
          service: "demo-plugin",
          image: "preview/demo-plugin:fixture",
          assets: {
            compose: "compose.yml",
            core_endpoint: "core-endpoint.json",
            source_connector: "source-connector.json"
          }
        }
      ];

const previewStates = {
  degraded: true,
  "not-initialized": true,
  ready: true,
  stopped: true
} satisfies Record<PreviewState, true>;

export function isPreviewState(value: string | undefined): value is PreviewState {
  return value !== undefined && Object.hasOwn(previewStates, value);
}

export function createPreviewOperator(
  initialState: PreviewState,
  output: PreviewOutput = process.stdout,
  options: PreviewOptions = {}
): AtlasCoreOperator {
  let deploymentState = initialState;
  const enabledPlugins = new Set<string>();
  const installedPlugins = new Map<string, PreviewInstalledPlugin>();
  let cancellationRequested = false;
  let lifecycleRunning = false;
  let cancelPendingPluginStep: (() => void) | undefined;
  let cancelPendingLifecycleStep: (() => void) | undefined;
  const pluginStepDelayMs = options.pluginStepDelayMs ?? 1_500;
  const lifecycleStepDelayMs = options.lifecycleStepDelayMs ?? 500;
  const startedAt = "2026-08-28T12:00:00.000Z";
  const preview = (message: string): unknown => output.write(`[preview only] ${message}\n`);

  const snapshot = (): DeploymentSnapshot => {
    if (deploymentState === "ready") {
      return { status: "ready", canReset: true, coreVersion: "0.1.5", detail: "Everything is healthy." };
    }
    if (deploymentState === "stopped") {
      return {
        status: "stopped",
        canReset: true,
        coreVersion: "0.1.5",
        detail: "Atlas Core is stopped. Durable storage is preserved."
      };
    }
    if (deploymentState === "not-initialized") {
      return { status: "not-initialized", canReset: false, detail: "Initialize Atlas Core on this host." };
    }
    return {
      status: "degraded",
      canReset: true,
      coreVersion: "0.1.5",
      detail: "Core API is running, but MinIO health is unavailable."
    };
  };

  const setFreshPreviewDeployment = (state: "ready" | "stopped"): void => {
    deploymentState = state;
    enabledPlugins.clear();
    installedPlugins.clear();
  };

  const services = (): DeploymentService[] => {
    if (deploymentState === "stopped" || deploymentState === "not-initialized") return [];
    return [
      service("api", "Core API", "api", "1.00%", "128MiB / 1GiB", "12.50%", "12"),
      service("source-gateway", "Source Gateway", "source_gateway", "0.20%", "42MiB / 1GiB", "4.10%", "6"),
      service("postgres", "PostgreSQL", "postgres", "2.00%", "256MiB / 1GiB", "25.00%", "13"),
      service(
        "minio",
        "MinIO",
        "minio",
        "3.00%",
        "192MiB / 1GiB",
        "18.75%",
        "14",
        deploymentState === "degraded" ? "unhealthy" : "healthy"
      )
    ];
  };

  const waitForPluginStep = async (): Promise<void> => {
    if (cancellationRequested || pluginStepDelayMs === 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cancelPendingPluginStep = undefined;
        resolve();
      }, pluginStepDelayMs);
      cancelPendingPluginStep = () => {
        clearTimeout(timer);
        cancelPendingPluginStep = undefined;
        resolve();
      };
    });
  };

  const waitForLifecycleStep = async (): Promise<void> => {
    if (cancellationRequested || lifecycleStepDelayMs === 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cancelPendingLifecycleStep = undefined;
        resolve();
      }, lifecycleStepDelayMs);
      cancelPendingLifecycleStep = () => {
        clearTimeout(timer);
        cancelPendingLifecycleStep = undefined;
        resolve();
      };
    });
  };

  const runLifecycle = async (
    operation: LifecycleOperation,
    report?: (progress: LifecycleOperationProgress) => void,
    options: LifecycleOperationOptions = {}
  ): Promise<LifecycleOperationResult> => {
    if (lifecycleRunning) {
      return {
        status: "failure",
        error: "Another lifecycle operation is already running.",
        snapshot: snapshot()
      };
    }
    if (operation === "reset" && !options.resetConfirmed) {
      return { status: "failure", error: "Reset requires explicit confirmation.", snapshot: snapshot() };
    }
    lifecycleRunning = true;
    const label = lifecycleOperationLabel(operation);
    const emit = (message: string, stage: LifecycleOperationProgress["stage"] = "operation"): void => {
      report?.({ message, stage });
    };
    emit(`${label} requested`);
    try {
      if (operation !== "init" && deploymentState === "not-initialized") {
        throw new Error("Atlas Core is not initialized. Run atlas-core init first.");
      }
      if (operation === "init" && deploymentState !== "not-initialized") {
        throw new Error("Atlas Core is already initialized. Choose Reset Atlas Core to start from scratch.");
      }
      if (operation === "restart" && deploymentState === "stopped") {
        throw new Error("Atlas Core is stopped; run atlas-core start instead of atlas-core restart.");
      }
      if (operation === "configure" && options.password === undefined) {
        throw new Error("An admin password is required.");
      }
      const previousState = deploymentState;
      const previousEnabledPlugins = new Set(enabledPlugins);
      const previousInstalledPlugins = new Map(installedPlugins);
      emit(`Running ${label.toLocaleLowerCase()}.`);
      await waitForLifecycleStep();
      if (cancellationRequested) {
        deploymentState = previousState;
        enabledPlugins.clear();
        for (const pluginId of previousEnabledPlugins) enabledPlugins.add(pluginId);
        installedPlugins.clear();
        for (const [pluginId, installed] of previousInstalledPlugins) installedPlugins.set(pluginId, installed);
        emit("Cancellation requested. Waiting for safe cleanup.", "cleanup");
        emit("Safe cleanup complete.", "cleanup");
        return {
          previousDeploymentPreserved: true,
          status: "cancelled",
          summary: `${label} cancelled. The existing deployment state was preserved.`
        };
      }
      if (operation === "init") {
        setFreshPreviewDeployment("stopped");
      } else if (operation === "reset") {
        setFreshPreviewDeployment("ready");
      } else if (operation === "configure") {
        deploymentState = previousState;
      } else {
        deploymentState = operation === "stop" ? "stopped" : "ready";
      }
      const summary = lifecycleOperationSummary(operation);
      emit(summary);
      return { status: "success", summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit(`${label} failed: ${message}`);
      return { status: "failure", error: message, snapshot: snapshot() };
    } finally {
      lifecycleRunning = false;
    }
  };

  const cancelPluginMutation = (
    action: "Enable" | "Disable",
    pluginId: string,
    previousEnabled: boolean,
    reportActivity?: PluginActivityReporter
  ): PluginOperationOutcome => {
    reportActivity?.({
      level: "failure",
      message: `${action} cancelled in the fixture`,
      stage: "operation"
    });
    reportActivity?.({
      level: "working",
      message: "Restoring previous fixture Plugin state",
      stage: "rollback"
    });
    if (previousEnabled) enabledPlugins.add(pluginId);
    else enabledPlugins.delete(pluginId);
    reportActivity?.({
      level: "success",
      message: "Previous fixture Plugin state restored",
      stage: "rollback"
    });
    return { previousDeploymentPreserved: true, status: "cancelled" };
  };

  const mutatePlugin = async (
    enabled: boolean,
    pluginId: string,
    reportActivity?: PluginActivityReporter
  ): Promise<PluginOperationOutcome> => {
    const plugin = requirePreviewPlugin(pluginId);
    if (deploymentState === "not-initialized") {
      throw new Error("Atlas Core is not initialized. Run atlas-core init first.");
    }

    const action = enabled ? "Enable" : "Disable";
    const previousEnabled = enabledPlugins.has(pluginId);
    if (deploymentState === "degraded" && previousEnabled !== enabled) {
      throw new Error(
        "Plugin changes require the current deployment to be fully healthy: minio is unhealthy. " +
          "Restore every Core and enabled Plugin service, or stop the deployment completely, before retrying."
      );
    }
    reportActivity?.({ level: "working", message: "Checking fixture Plugin state", stage: "operation" });
    await waitForPluginStep();
    if (cancellationRequested) return cancelPluginMutation(action, pluginId, previousEnabled, reportActivity);

    reportActivity?.({
      level: "working",
      message: `${enabled ? "Enabling" : "Disabling"} ${plugin.displayName} in memory`,
      stage: "operation"
    });
    await waitForPluginStep();
    if (cancellationRequested) return cancelPluginMutation(action, pluginId, previousEnabled, reportActivity);

    if (enabled) enabledPlugins.add(pluginId);
    else enabledPlugins.delete(pluginId);
    reportActivity?.({
      level: "success",
      message: `${plugin.displayName} ${enabled ? "enabled" : "disabled"} in the fixture`,
      stage: "operation"
    });
    return { status: "success" };
  };

  const update = async (scope: UpdateScope, _expectedVersion?: string): Promise<void> => {
    preview(`${scope === "all" ? "CLI and Core" : "CLI-only"} update simulated. Nothing was installed.`);
  };

  return {
    cancelPending() {
      cancellationRequested = true;
      cancelPendingPluginStep?.();
      cancelPendingLifecycleStep?.();
    },
    async checkForUpdates() {
      return {
        cliVersion: "0.1.5",
        latestVersion: "0.1.6",
        cliUpdateAvailable: true,
        coreUpdateAvailable: deploymentState !== "not-initialized",
        ...(deploymentState === "not-initialized" ? {} : { coreVersion: "0.1.5" })
      };
    },
    async configureAdminPassword(_password) {
      if (!lifecycleRunning) preview("Admin password accepted by the fixture. Nothing was stored.");
    },
    async details(_signal) {
      return {
        snapshot: snapshot(),
        cliVersion: "0.1.5",
        coreVersion: deploymentState === "not-initialized" ? "Not initialized" : "0.1.5",
        initializedAt: deploymentState === "not-initialized" ? "Not initialized" : startedAt,
        apiEndpoint: "http://127.0.0.1:8000",
        minioEndpoint: "http://127.0.0.1:9001",
        services: services(),
        ...(deploymentState === "not-initialized"
          ? {}
          : { image: "ghcr.io/the-drunken-coder/atlas-core@sha256:cfe582…" }),
        ...(deploymentState === "degraded" ? { performanceError: "MinIO did not return Docker statistics." } : {})
      };
    },
    async diagnostics(): Promise<DiagnosticsResult> {
      return {
        healthy: true,
        checks: [
          { label: "Docker daemon", status: "ok", detail: "fixture healthy" },
          { label: "Docker Compose", status: "ok", detail: "2.17+ fixture healthy" },
          { label: "configuration", status: "ok", detail: "fixture ownership matched" }
        ]
      };
    },
    async doctor() {
      const result = await this.diagnostics();
      for (const check of result.checks) preview(`${check.label}: ${check.detail}`);
      return result.healthy;
    },
    async init() {
      if (deploymentState !== "not-initialized") {
        throw new Error("Atlas Core is already initialized. Choose Reset Atlas Core to start from scratch.");
      }
      preview("Initialization simulated. No credentials, containers, or volumes were created.");
      setFreshPreviewDeployment("stopped");
    },
    async logs(serviceId, follow) {
      const stream = await this.openLogStream(serviceId, follow);
      const remove = stream.onLine((line) => output.write(`${line}\n`));
      try {
        await stream.wait();
      } finally {
        remove();
        await stream.close();
      }
    },
    async openLogStream(serviceId, follow = true) {
      const logsByService = {
        api: ["2026-08-30T14:12:03Z core-api ready on 127.0.0.1:8000"],
        "source-gateway": ["2026-08-30T14:12:04Z source-gateway no connectors configured"],
        postgres: ["2026-08-30T14:12:05Z postgres accepting connections"],
        minio: ["2026-08-30T14:12:06Z minio bucket atlas ready"]
      } satisfies Record<DeploymentService["id"], string[]>;
      const lines = serviceId === undefined ? Object.values(logsByService).flat() : logsByService[serviceId];
      preview(`Showing fixture logs for ${serviceId ?? "all services"}.`);
      return createPreviewLogStream(serviceId, lines, follow);
    },
    async pluginDisable(pluginId, reportActivity) {
      return await mutatePlugin(false, pluginId, reportActivity);
    },
    async pluginEnable(pluginId, reportActivity) {
      return await mutatePlugin(true, pluginId, reportActivity);
    },
    async pluginInstall(pluginId, version, reportActivity): Promise<PluginOperationOutcome> {
      const plugin = requirePreviewPlugin(pluginId);
      if (deploymentState === "not-initialized") {
        throw new Error("Atlas Core is not initialized. Run atlas-core init first.");
      }
      if (installedPlugins.has(pluginId)) throw new Error(`Plugin ${pluginId} is already installed; use update.`);
      const selectedVersion = version ?? PREVIEW_PLUGIN_VERSIONS[0];
      if (!PREVIEW_PLUGIN_VERSIONS.includes(selectedVersion as (typeof PREVIEW_PLUGIN_VERSIONS)[number])) {
        throw new Error(`Unknown fixture Plugin release ${pluginId} ${selectedVersion}.`);
      }
      reportActivity?.({ level: "working", message: "Checking fixture Plugin catalog", stage: "operation" });
      await waitForPluginStep();
      if (cancellationRequested) {
        reportActivity?.({ level: "failure", message: "Install cancelled in the fixture", stage: "operation" });
        reportActivity?.({ level: "success", message: "Previous fixture Plugin state restored", stage: "rollback" });
        return { previousDeploymentPreserved: true, status: "cancelled" };
      }
      reportActivity?.({
        level: "working",
        message: `Installing ${plugin.displayName} ${selectedVersion}`,
        stage: "operation"
      });
      await waitForPluginStep();
      if (cancellationRequested) {
        reportActivity?.({ level: "failure", message: "Install cancelled in the fixture", stage: "operation" });
        reportActivity?.({ level: "success", message: "Previous fixture Plugin state restored", stage: "rollback" });
        return { previousDeploymentPreserved: true, status: "cancelled" };
      }
      installedPlugins.set(pluginId, { previousVersion: null, selectedVersion });
      preview(`Installed ${plugin.displayName} ${selectedVersion}.`);
      reportActivity?.({
        level: "success",
        message: `Installed ${plugin.displayName} ${selectedVersion}.`,
        stage: "operation"
      });
      return { status: "success" };
    },
    async pluginLogs(pluginId, follow) {
      if (deploymentState === "not-initialized") {
        throw new Error("Atlas Core is not initialized. Run atlas-core init first.");
      }
      if (!enabledPlugins.has(pluginId)) throw new Error(`Plugin ${pluginId} is not enabled.`);
      requirePreviewPlugin(pluginId);
      const stream = await this.openPluginLogStream?.(pluginId, follow);
      if (!stream) return;
      const remove = stream.onLine((line) => output.write(`${line}\n`));
      try {
        await stream.wait();
      } finally {
        remove();
        await stream.close();
      }
    },
    async openPluginLogStream(pluginId, follow = true) {
      if (deploymentState === "not-initialized") {
        throw new Error("Atlas Core is not initialized. Run atlas-core init first.");
      }
      if (!enabledPlugins.has(pluginId)) throw new Error(`Plugin ${pluginId} is not enabled.`);
      const plugin = requirePreviewPlugin(pluginId);
      preview(`Showing fixture logs for ${plugin.displayName}.`);
      return createPreviewLogStream(
        plugin.service,
        [
          `2026-08-30T14:12:07Z ${plugin.service} fixture query ready`,
          `2026-08-30T14:12:08Z ${plugin.service} fixture index healthy`
        ],
        follow
      );
    },
    async pluginStatuses(pluginId) {
      const plugins = pluginId === undefined ? PREVIEW_CATALOG : [requirePreviewPlugin(pluginId)];
      return plugins.map((plugin) => {
        const enabled = enabledPlugins.has(plugin.pluginId);
        const running = enabled && deploymentState !== "stopped" && deploymentState !== "not-initialized";
        const installed = installedPlugins.get(plugin.pluginId);
        return {
          pluginId: plugin.pluginId,
          displayName: plugin.displayName,
          lifecycle: plugin.lifecycle,
          enabled,
          packaged: plugin.image !== null,
          ...(installed
            ? {
                installed: true,
                selectedVersion: installed.selectedVersion,
                previousVersion: installed.previousVersion,
                availableVersions: PREVIEW_PLUGIN_VERSIONS,
                compatibility: "compatible" as const,
                revoked: false
              }
            : {}),
          ...(running ? { state: "running", health: "healthy" } : {})
        };
      });
    },
    runLifecycle,
    async pluginUpdate(pluginId) {
      const plugin = requirePreviewPlugin(pluginId);
      const installed = installedPlugins.get(pluginId);
      if (!installed) throw new Error(`Plugin ${pluginId} is not installed.`);
      const nextVersion = PREVIEW_PLUGIN_VERSIONS[0];
      if (installed.selectedVersion === nextVersion) {
        preview(`${plugin.displayName} ${installed.selectedVersion} is current.`);
        return;
      }
      installedPlugins.set(pluginId, { previousVersion: installed.selectedVersion, selectedVersion: nextVersion });
      preview(`Updated ${plugin.displayName} to ${nextVersion}.`);
    },
    async pluginRollback(pluginId) {
      const plugin = requirePreviewPlugin(pluginId);
      const installed = installedPlugins.get(pluginId);
      if (!installed) throw new Error(`Plugin ${pluginId} is not installed.`);
      if (!installed.previousVersion) throw new Error(`Plugin ${pluginId} has no previous release to roll back to.`);
      installedPlugins.set(pluginId, {
        previousVersion: installed.selectedVersion,
        selectedVersion: installed.previousVersion
      });
      preview(`Rolled back ${plugin.displayName} to ${installed.previousVersion}.`);
    },
    async pluginUninstall(pluginId) {
      const plugin = requirePreviewPlugin(pluginId);
      if (enabledPlugins.has(pluginId)) throw new Error(`Plugin ${pluginId} must be disabled before uninstall.`);
      if (!installedPlugins.delete(pluginId)) throw new Error(`Plugin ${pluginId} is not installed.`);
      preview(`Uninstalled ${plugin.displayName}.`);
    },
    async pluginRefresh() {
      preview("Plugin catalog refreshed.");
    },
    async pluginRotateCoreKey() {
      preview("Managed Plugin key rotated.");
    },
    resumeAfterCancellation() {
      cancellationRequested = false;
    },
    async reset() {
      if (deploymentState === "not-initialized") {
        throw new Error("Atlas Core is not initialized. Run atlas-core init first.");
      }
      preview("Reset simulated. No credentials, containers, or volumes were deleted.");
      setFreshPreviewDeployment("ready");
    },
    async restart() {
      preview("Restart simulated. No images were pulled and no containers changed.");
      deploymentState = "ready";
    },
    async snapshot() {
      return snapshot();
    },
    async start() {
      preview("Start simulated. No containers changed.");
      deploymentState = "ready";
    },
    async status() {
      preview("Status command simulated.");
      return deploymentState === "ready";
    },
    async stop() {
      preview("Stop simulated. No containers changed.");
      deploymentState = "stopped";
    },
    update,
    async updateWithProgress(scope, _expectedVersion, report?: UpdateReporter) {
      report?.({ message: "Running the fixture update", stage: "operation" });
      await update(scope, _expectedVersion);
    }
  };
}

function requirePreviewPlugin(pluginId: string): PluginCatalogEntry {
  const plugin = PREVIEW_CATALOG.find((candidate) => candidate.pluginId === pluginId);
  if (!plugin) throw new Error(`Unknown first-party Plugin: ${pluginId}`);
  return plugin;
}

function service(
  id: DeploymentService["id"],
  label: string,
  containerSuffix: string,
  cpuPercent: string,
  memoryUsage: string,
  memoryPercent: string,
  processes: string,
  health = "healthy"
): DeploymentService {
  return {
    id,
    label,
    container: `atlas_core_production_${containerSuffix}`,
    state: "running",
    health,
    cpuPercent,
    memoryUsage,
    memoryPercent,
    networkIO: "1MB / 2MB",
    blockIO: "3MB / 4MB",
    processes,
    uptime: "4d 2h",
    restarts: 0,
    image: "ghcr.io/the-drunken-coder/atlas-core@sha256:cfe582…"
  };
}

function createPreviewLogStream(service: string | undefined, lines: string[], follow: boolean): LogStream {
  const lineListeners = new Set<(line: string) => void>();
  const pendingLines: string[] = [];
  const closeListeners = new Set<(error?: Error) => void>();
  let closed = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const finish = (): void => {
    if (closed) return;
    closed = true;
    resolveDone();
    for (const listener of closeListeners) listener();
    lineListeners.clear();
    closeListeners.clear();
  };
  setTimeout(() => {
    for (const line of lines) {
      if (closed) return;
      if (lineListeners.size === 0) pendingLines.push(line);
      else for (const listener of lineListeners) listener(line);
    }
    if (!follow) finish();
  }, 0);
  return {
    service,
    onLine(listener) {
      lineListeners.add(listener);
      for (const line of pendingLines.splice(0)) listener(line);
      return () => lineListeners.delete(listener);
    },
    onError() {
      return () => undefined;
    },
    onClose(listener) {
      if (closed) listener();
      else closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    wait() {
      return done;
    },
    async close() {
      finish();
      await done;
    }
  };
}
