import { describe, expect, it, vi } from "vitest";
import { HttpTransport } from "../src/http.js";
import { ReconnectTimer } from "../src/sync-engine-reconnect.js";
import { RecoveryCoordinator, RecoveryRunner } from "../src/sync-engine-recovery.js";

describe("sync-engine internal lifecycle policies", () => {
  it("does not schedule duplicate reconnect timers", () => {
    vi.useFakeTimers();
    try {
      const timer = new ReconnectTimer();
      const callback = vi.fn();

      timer.schedule(callback);
      timer.schedule(callback);

      expect(timer.pending).toBe(true);
      vi.advanceTimersByTime(1_000);
      expect(callback).toHaveBeenCalledOnce();
      expect(timer.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start recovery for a stale lifecycle generation", async () => {
    const recovery = new RecoveryCoordinator();
    const recover = vi.fn(async () => true);

    await expect(recovery.start(3, 0, () => false, recover)).resolves.toBe(false);
    expect(recover).not.toHaveBeenCalled();
  });

  it("coalesces matching recovery operations and clears them on completion", async () => {
    const recovery = new RecoveryCoordinator();
    let resolveRecovery!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      resolveRecovery = resolve;
    });

    const first = recovery.start(
      3,
      7,
      () => true,
      () => pending
    );
    expect(
      recovery.start(
        3,
        7,
        () => true,
        () => Promise.resolve(false)
      )
    ).toBe(first);
    resolveRecovery(true);
    await expect(first).resolves.toBe(true);
    expect(recovery.activeRecoveryPromise()).toBeUndefined();
  });

  it("stops a recovery runner before issuing a stale request", async () => {
    const runner = new RecoveryRunner(
      new HttpTransport({ baseUrl: "http://atlas.test", fetchImpl: vi.fn(), requestTimeoutMs: 1_000 })
    );

    await expect(runner.run(0, () => false, vi.fn(), vi.fn())).resolves.toEqual({
      snapshotVersion: undefined,
      superseded: true
    });
  });
});
