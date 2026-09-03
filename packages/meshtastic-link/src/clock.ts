export type TimerHandle = object;

export interface Clock {
  now(): number;
  schedule(delayMs: number, callback: () => void | Promise<void>): TimerHandle;
  cancel(handle: TimerHandle): void;
}

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }

  schedule(delayMs: number, callback: () => void | Promise<void>): TimerHandle {
    return setTimeout(() => void callback(), delayMs);
  }

  cancel(handle: TimerHandle): void {
    clearTimeout(handle as NodeJS.Timeout);
  }
}

type Scheduled = {
  handle: TimerHandle;
  at: number;
  order: number;
  callback: () => void | Promise<void>;
};

export class VirtualClock implements Clock {
  private current: number;
  private nextOrder = 0;
  private readonly scheduled: Scheduled[] = [];

  constructor(startMs = 0) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  schedule(delayMs: number, callback: () => void | Promise<void>): TimerHandle {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError("delayMs must be a non-negative finite number");
    const handle = {};
    this.scheduled.push({ handle, at: this.current + delayMs, order: this.nextOrder++, callback });
    return handle;
  }

  cancel(handle: TimerHandle): void {
    const index = this.scheduled.findIndex((item) => item.handle === handle);
    if (index >= 0) this.scheduled.splice(index, 1);
  }

  async advanceBy(durationMs: number): Promise<void> {
    await this.advanceTo(this.current + durationMs);
  }

  async advanceTo(targetMs: number): Promise<void> {
    if (!Number.isFinite(targetMs) || targetMs < this.current)
      throw new RangeError("virtual time cannot move backward");
    while (true) {
      this.scheduled.sort((left, right) => left.at - right.at || left.order - right.order);
      const next = this.scheduled[0];
      if (next === undefined || next.at > targetMs) break;
      this.scheduled.shift();
      this.current = next.at;
      await next.callback();
    }
    this.current = targetMs;
  }

  async runUntilIdle(maxCallbacks = 100_000): Promise<void> {
    for (let count = 0; this.scheduled.length > 0; count++) {
      if (count >= maxCallbacks) throw new Error("virtual clock did not become idle");
      const nextAt = Math.min(...this.scheduled.map((item) => item.at));
      await this.advanceTo(nextAt);
    }
  }

  pendingCount(): number {
    return this.scheduled.length;
  }
}
