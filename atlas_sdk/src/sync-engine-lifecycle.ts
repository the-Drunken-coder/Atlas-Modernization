export class SyncLifecycle {
  private generation = 0;
  private feedConnectionAttempt = 0;
  private startSyncPromise: Promise<void> | undefined;

  currentGeneration(): number {
    return this.generation;
  }

  beginStart(): number {
    return ++this.generation;
  }

  stop(): void {
    this.generation++;
    this.startSyncPromise = undefined;
  }

  isCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  beginFeedConnectionAttempt(): number {
    return ++this.feedConnectionAttempt;
  }

  currentFeedConnectionAttempt(): number {
    return this.feedConnectionAttempt;
  }

  isCurrentFeedConnection(generation: number, attempt: number): boolean {
    return this.isCurrent(generation) && this.feedConnectionAttempt === attempt;
  }

  getStartSyncPromise(): Promise<void> | undefined {
    return this.startSyncPromise;
  }

  setStartSyncPromise(promise: Promise<void> | undefined): void {
    this.startSyncPromise = promise;
  }

  clearStartSyncPromiseIf(promise: Promise<void>): void {
    if (this.startSyncPromise === promise) {
      this.startSyncPromise = undefined;
    }
  }
}
