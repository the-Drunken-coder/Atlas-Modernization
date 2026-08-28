const DEFAULT_RECONNECT_DELAY_MS = 1_000;

export class ReconnectTimer {
  private timer: ReturnType<typeof setTimeout> | undefined;

  get pending(): boolean {
    return this.timer !== undefined;
  }

  schedule(callback: () => void): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      callback();
    }, DEFAULT_RECONNECT_DELAY_MS);
  }

  clear(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
