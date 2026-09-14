/**
 * Shared headless operator contracts used by the direct CLI, terminal UI, and
 * fixture preview. This module intentionally has no rendering or terminal
 * dependencies so each interface can consume the same typed deployment data.
 */

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

export type DeploymentServiceId = DeploymentService["id"];

export type LogStream = {
  readonly service: string | undefined;
  onLine(listener: (line: string) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
  wait(): Promise<void>;
  close(): Promise<void>;
};

export type DiagnosticCheck = {
  label: string;
  status: "ok" | "failure";
  detail: string;
};

export type DiagnosticsResult = {
  healthy: boolean;
  checks: DiagnosticCheck[];
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

export type UpdateProgress = {
  message: string;
  stage: "operation" | "cleanup";
};

export type UpdateReporter = (progress: UpdateProgress) => void;

export type LifecycleOperation = "init" | "start" | "stop" | "restart" | "reset" | "configure";

export type LifecycleOperationOptions = {
  /** The TUI owns reset confirmation; direct callers keep the prompt by default. */
  resetConfirmed?: boolean;
  manual?: boolean;
  /** Private input for the admin-password operation. Never include in progress output. */
  password?: string;
};

export type LifecycleOperationProgress = {
  message: string;
  stage: "operation" | "cleanup";
};

export type LifecycleOperationResult =
  | { status: "success"; summary: string }
  | { status: "failure"; error: string; snapshot?: DeploymentSnapshot }
  | { previousDeploymentPreserved: true; status: "cancelled"; summary: string; snapshot?: DeploymentSnapshot };

export type LifecycleOperationReporter = (progress: LifecycleOperationProgress) => void;

const LIFECYCLE_OPERATION_DETAILS: Readonly<Record<LifecycleOperation, { label: string; summary: string }>> = {
  configure: { label: "Change admin password", summary: "Atlas Core admin password updated for username admin." },
  init: { label: "Initialize Atlas Core", summary: "Atlas Core initialized. Choose Start Atlas Core when ready." },
  restart: { label: "Restart Atlas Core", summary: "Atlas Core restarted and is healthy." },
  reset: { label: "Reset Atlas Core", summary: "Atlas Core reset is complete. A new deployment is running." },
  start: { label: "Start Atlas Core", summary: "Atlas Core started and is healthy." },
  stop: { label: "Stop Atlas Core", summary: "Atlas Core stopped. Durable volumes were preserved." }
};

export function lifecycleOperationLabel(operation: LifecycleOperation): string {
  return LIFECYCLE_OPERATION_DETAILS[operation].label;
}

export function lifecycleOperationSummary(operation: LifecycleOperation): string {
  return LIFECYCLE_OPERATION_DETAILS[operation].summary;
}

export type PluginDeploymentStatus = {
  pluginId: string;
  displayName: string;
  lifecycle: "query_only";
  enabled: boolean;
  packaged: boolean;
  /** Independent-release state, omitted by the bundled-plugin compatibility path. */
  installed?: boolean;
  selectedVersion?: string | null | undefined;
  previousVersion?: string | null | undefined;
  availableVersions?: readonly string[];
  compatibility?: "compatible" | "incompatible" | "unknown";
  revoked?: boolean;
  revocationReason?: string;
  error?: string;
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
  diagnostics(): Promise<DiagnosticsResult>;
  doctor(): Promise<boolean>;
  init(): Promise<void>;
  logs(service: "api" | "minio" | "postgres" | "source-gateway" | undefined, follow: boolean): Promise<void>;
  openLogStream(service: DeploymentServiceId | undefined, follow?: boolean): Promise<LogStream>;
  pluginDisable(pluginId: string, reportActivity?: PluginActivityReporter): Promise<PluginOperationOutcome>;
  pluginEnable(pluginId: string, reportActivity?: PluginActivityReporter): Promise<PluginOperationOutcome>;
  pluginInstall?(pluginId: string, version?: string): Promise<void>;
  pluginLogs(pluginId: string, follow: boolean): Promise<void>;
  openPluginLogStream?(pluginId: string, follow?: boolean): Promise<LogStream>;
  pluginUpdate?(pluginId: string): Promise<void>;
  pluginRollback?(pluginId: string): Promise<void>;
  pluginUninstall?(pluginId: string): Promise<void>;
  pluginRefresh?(): Promise<void>;
  pluginRotateCoreKey?(): Promise<void>;
  pluginStatuses(pluginId?: string): Promise<PluginDeploymentStatus[]>;
  /** Run one serialized lifecycle mutation while reporting typed progress. */
  runLifecycle(
    operation: LifecycleOperation,
    report?: LifecycleOperationReporter,
    options?: LifecycleOperationOptions
  ): Promise<LifecycleOperationResult>;
  resumeAfterCancellation(): void;
  reset(options?: { confirmed?: boolean; manual?: boolean }): Promise<void>;
  restart(): Promise<void>;
  snapshot(): Promise<DeploymentSnapshot>;
  start(): Promise<void>;
  status(): Promise<boolean>;
  stop(): Promise<void>;
  update(scope: UpdateScope, expectedVersion?: string, coreBackupConfirmed?: boolean): Promise<void>;
  /** Run an update while retaining subprocess output as typed interface progress. */
  updateWithProgress(
    scope: UpdateScope,
    expectedVersion?: string,
    coreBackupConfirmed?: boolean,
    report?: UpdateReporter
  ): Promise<void>;
};

export type InteractiveCLI = {
  configureAdmin(operator: AtlasCoreOperator): Promise<void>;
  runMenu(operator: AtlasCoreOperator): Promise<void>;
  runUpdate(operator: AtlasCoreOperator): Promise<void>;
};

/**
 * Development-only terminal entrypoint for incrementally replacing the
 * legacy menu. It deliberately exposes only the slice that is implemented by
 * the development surface; the shipped CLI keeps using InteractiveCLI.
 */
export type DevelopmentInteractiveCLI = Pick<InteractiveCLI, "runMenu">;
