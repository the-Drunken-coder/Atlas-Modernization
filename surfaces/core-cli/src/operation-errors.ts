export class CommandCancelledError extends Error {
  constructor() {
    super("Atlas Core command was cancelled.");
    this.name = "CommandCancelledError";
  }
}

export class OperationCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationCleanupError";
  }
}

export type PluginFailureOutcome =
  | "rejected"
  | "restored"
  | "recovery-incomplete"
  | "committed-cleanup-incomplete"
  | "unknown";

export type PluginOperationFailureOptions = {
  outcome: PluginFailureOutcome;
  operationError: unknown;
  recoveryError?: unknown;
  cleanupErrors?: readonly unknown[];
  pluginId?: string;
  updatedPluginIds?: readonly string[];
  cancelled?: boolean;
  requestedChangeBegan?: boolean;
};

/** A failed Plugin request with the outcome facts established by its transaction owner. */
export class PluginOperationFailure extends Error {
  readonly outcome: PluginFailureOutcome;
  readonly operationError: Error;
  readonly recoveryError: Error | undefined;
  readonly cleanupErrors: readonly Error[];
  readonly pluginId: string | undefined;
  readonly updatedPluginIds: readonly string[];
  readonly cancelled: boolean;
  readonly requestedChangeBegan: boolean | undefined;

  constructor(options: PluginOperationFailureOptions) {
    const operationError = asError(options.operationError);
    const recoveryError = options.recoveryError === undefined ? undefined : asError(options.recoveryError);
    super(operationError.message, { cause: operationError });
    this.name = "PluginOperationFailure";
    this.outcome = options.outcome;
    this.operationError = operationError;
    this.recoveryError = recoveryError;
    this.cleanupErrors = (options.cleanupErrors ?? []).map(asError);
    this.pluginId = options.pluginId;
    this.updatedPluginIds = [...(options.updatedPluginIds ?? [])];
    this.cancelled = options.cancelled ?? false;
    this.requestedChangeBegan = options.requestedChangeBegan;
  }
}

/** Whether the retained facts require the operator to inspect recovery before retrying. */
export function pluginFailureRequiresRecoveryStatus(failure: PluginOperationFailure): boolean {
  return (
    failure.outcome === "recovery-incomplete" ||
    failure.outcome === "committed-cleanup-incomplete" ||
    failure.outcome === "unknown" ||
    failure.cleanupErrors.length > 0
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
