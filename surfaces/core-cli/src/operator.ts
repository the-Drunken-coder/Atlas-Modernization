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
  doctor(): Promise<boolean>;
  init(): Promise<void>;
  logs(service: "api" | "minio" | "postgres" | "source-gateway" | undefined, follow: boolean): Promise<void>;
  pluginDisable(pluginId: string, reportActivity?: PluginActivityReporter): Promise<PluginOperationOutcome>;
  pluginEnable(pluginId: string, reportActivity?: PluginActivityReporter): Promise<PluginOperationOutcome>;
  pluginInstall?(pluginId: string, version?: string): Promise<void>;
  pluginLogs(pluginId: string, follow: boolean): Promise<void>;
  pluginUpdate?(pluginId: string): Promise<void>;
  pluginRollback?(pluginId: string): Promise<void>;
  pluginUninstall?(pluginId: string): Promise<void>;
  pluginRefresh?(): Promise<void>;
  pluginRotateCoreKey?(): Promise<void>;
  pluginStatuses(pluginId?: string): Promise<PluginDeploymentStatus[]>;
  resumeAfterCancellation(): void;
  reset(options?: { manual?: boolean }): Promise<void>;
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

/**
 * Development-only terminal entrypoint for incrementally replacing the
 * legacy menu. It deliberately exposes only the slice that is implemented by
 * the development surface; the shipped CLI keeps using InteractiveCLI.
 */
export type DevelopmentInteractiveCLI = Pick<InteractiveCLI, "runMenu">;
