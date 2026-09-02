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
