import type {
  AtlasCoreOperator,
  DeploymentService,
  DeploymentSnapshot,
  PluginActivityReporter,
  PluginDeploymentStatus,
  PluginOperationOutcome
} from "./terminal-ui.js";

type PreviewState = DeploymentSnapshot["status"];
type PreviewOutput = { write(data: string): unknown };
type PreviewOptions = { pluginStepDelayMs?: number };

const previewPlugin = {
  pluginId: "building_scan",
  displayName: "Building Scan",
  lifecycle: "query_only",
  packaged: true
} as const satisfies Omit<PluginDeploymentStatus, "enabled" | "health" | "state">;

export function isPreviewState(value: string | undefined): value is PreviewState {
  return value === "ready" || value === "stopped" || value === "degraded" || value === "not-initialized";
}

export function createPreviewOperator(
  initialState: PreviewState,
  output: PreviewOutput = process.stdout,
  options: PreviewOptions = {}
): AtlasCoreOperator {
  let deploymentState = initialState;
  let pluginEnabled = false;
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
    pluginEnabled = previousEnabled;
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
    requirePreviewPlugin(pluginId);
    if (deploymentState === "not-initialized") {
      throw new Error("Atlas Core is not initialized. Run atlas-core init first.");
    }

    const action = enabled ? "Enable" : "Disable";
    const previousEnabled = pluginEnabled;
    reportActivity?.({ level: "working", message: "Checking fixture Plugin state", stage: "operation" });
    await waitForPluginStep();
    if (cancellationRequested) return cancelPluginMutation(action, previousEnabled, reportActivity);

    reportActivity?.({
      level: "working",
      message: `${enabled ? "Enabling" : "Disabling"} ${previewPlugin.displayName} in memory`,
      stage: "operation"
    });
    await waitForPluginStep();
    if (cancellationRequested) return cancelPluginMutation(action, previousEnabled, reportActivity);

    pluginEnabled = enabled;
    reportActivity?.({
      level: "success",
      message: `${previewPlugin.displayName} ${enabled ? "enabled" : "disabled"} in the fixture`,
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
      pluginEnabled = false;
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
      requirePreviewPlugin(pluginId);
      if (!pluginEnabled) throw new Error(`Plugin ${pluginId} is not enabled.`);
      preview(`Showing fixture logs for ${previewPlugin.displayName}.`);
      output.write("2026-08-30T14:12:07Z building-scan-plugin fixture query ready\n");
      output.write("2026-08-30T14:12:08Z building-scan-plugin fixture index healthy\n");
    },
    async pluginStatuses(pluginId) {
      if (pluginId !== undefined) requirePreviewPlugin(pluginId);
      const running = pluginEnabled && deploymentState !== "stopped" && deploymentState !== "not-initialized";
      return [
        {
          ...previewPlugin,
          enabled: pluginEnabled,
          ...(running ? { state: "running", health: "healthy" } : {})
        }
      ];
    },
    resumeAfterCancellation() {
      cancellationRequested = false;
    },
    async reset() {
      preview("Reset simulated. No credentials, containers, or volumes were deleted.");
      deploymentState = "ready";
      pluginEnabled = false;
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

function requirePreviewPlugin(pluginId: string): void {
  if (pluginId !== previewPlugin.pluginId) throw new Error(`Unknown Plugin: ${pluginId}`);
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
