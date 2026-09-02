import { PLUGIN_CATALOG, type PluginCatalogEntry } from "./plugin-catalog.js";
import type {
  AtlasCoreOperator,
  DeploymentService,
  DeploymentSnapshot,
  PluginActivityReporter,
  PluginOperationOutcome
} from "./terminal-ui.js";

type PreviewState = DeploymentSnapshot["status"];
type PreviewOutput = { write(data: string): unknown };
type PreviewOptions = { pluginStepDelayMs?: number };

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
  let cancellationRequested = false;
  let cancelPendingPluginStep: (() => void) | undefined;
  const pluginStepDelayMs = options.pluginStepDelayMs ?? 1_500;
  const startedAt = "2026-08-28T12:00:00.000Z";
  const preview = (message: string): unknown => output.write(`[preview only] ${message}\n`);

  const snapshot = (): DeploymentSnapshot => {
    if (deploymentState === "ready") return { status: "ready", detail: "Everything is healthy." };
    if (deploymentState === "stopped") {
      return { status: "stopped", detail: "Atlas Core is stopped. Durable storage is preserved." };
    }
    if (deploymentState === "not-initialized") {
      return { status: "not-initialized", detail: "Initialize Atlas Core on this host." };
    }
    return { status: "degraded", detail: "Core API is running, but MinIO health is unavailable." };
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

  return {
    cancelPending() {
      cancellationRequested = true;
      cancelPendingPluginStep?.();
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
      preview("Admin password accepted by the fixture. Nothing was stored.");
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
    async doctor() {
      preview("Docker daemon: fixture healthy");
      preview("Compose 2.17+: fixture healthy");
      preview("Deployment ownership: fixture matched");
      return true;
    },
    async init() {
      preview("Initialization simulated. No credentials, containers, or volumes were created.");
      deploymentState = "ready";
      enabledPlugins.clear();
    },
    async logs(serviceId, _follow) {
      const label = serviceId ?? "all services";
      preview(`Showing fixture logs for ${label}.`);
      output.write("2026-08-30T14:12:03Z core-api ready on 127.0.0.1:8000\n");
      output.write("2026-08-30T14:12:04Z source-gateway no connectors configured\n");
      output.write("2026-08-30T14:12:05Z postgres accepting connections\n");
      output.write("2026-08-30T14:12:06Z minio bucket atlas ready\n");
    },
    async pluginDisable(pluginId, reportActivity) {
      return await mutatePlugin(false, pluginId, reportActivity);
    },
    async pluginEnable(pluginId, reportActivity) {
      return await mutatePlugin(true, pluginId, reportActivity);
    },
    async pluginLogs(pluginId, _follow) {
      const plugin = requirePreviewPlugin(pluginId);
      if (!enabledPlugins.has(pluginId)) throw new Error(`Plugin ${pluginId} is not enabled.`);
      preview(`Showing fixture logs for ${plugin.displayName}.`);
      output.write(`2026-08-30T14:12:07Z ${plugin.service} fixture query ready\n`);
      output.write(`2026-08-30T14:12:08Z ${plugin.service} fixture index healthy\n`);
    },
    async pluginStatuses(pluginId) {
      const plugins = pluginId === undefined ? PLUGIN_CATALOG : [requirePreviewPlugin(pluginId)];
      return plugins.map((plugin) => {
        const enabled = enabledPlugins.has(plugin.pluginId);
        const running = enabled && deploymentState !== "stopped" && deploymentState !== "not-initialized";
        return {
          pluginId: plugin.pluginId,
          displayName: plugin.displayName,
          lifecycle: plugin.lifecycle,
          enabled,
          packaged: plugin.image !== null,
          ...(running ? { state: "running", health: "healthy" } : {})
        };
      });
    },
    resumeAfterCancellation() {
      cancellationRequested = false;
    },
    async reset() {
      preview("Reset simulated. No credentials, containers, or volumes were deleted.");
      deploymentState = "ready";
      enabledPlugins.clear();
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
    async update(scope, _expectedVersion, _coreBackupConfirmed) {
      preview(`${scope === "all" ? "CLI and Core" : "CLI-only"} update simulated. Nothing was installed.`);
    }
  };
}

function requirePreviewPlugin(pluginId: string): PluginCatalogEntry {
  const plugin = PLUGIN_CATALOG.find((candidate) => candidate.pluginId === pluginId);
  if (!plugin) throw new Error(`Unknown Plugin: ${pluginId}`);
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
