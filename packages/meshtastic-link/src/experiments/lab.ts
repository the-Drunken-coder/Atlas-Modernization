import { setTimeout as delay } from "node:timers/promises";
import { record } from "./config.js";

export class LabClient {
  constructor(private readonly origin: string) {}
  async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.origin), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(path.startsWith("/api/simulation/") ? 120_000 : 10_000),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    });
    const value: unknown = await response.json();
    if (!response.ok)
      throw new Error(`Meshtastic Lab ${method} ${path}: HTTP ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  async waitForState(expected: "RUNNING" | "STOPPED", signal?: AbortSignal) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const state = await this.request("/api/state");
      if (!record(state) || typeof state.state !== "string") throw new Error("Invalid Meshtastic Lab state response");
      if (state.state === expected) return;
      if (state.state === "FAILED") throw new Error(`Meshtastic Lab failed: ${JSON.stringify(state)}`);
      await delay(500, undefined, signal === undefined ? {} : { signal });
    }
    throw new Error(`Meshtastic Lab did not reach ${expected}`);
  }
}

/** Cursor gaps invalidate packet evidence instead of silently understating RF cost. */
export class LabEvidence {
  private sequence = 0;
  private stream: string | undefined;
  private complete = true;
  private events: Record<string, unknown>[] = [];
  constructor(private readonly lab: LabClient) {}
  async begin() {
    const page = await this.lab.request("/api/events/history?limit=1");
    if (
      !record(page) ||
      typeof page.streamId !== "string" ||
      typeof page.latestSequence !== "number" ||
      !Number.isSafeInteger(page.latestSequence) ||
      page.latestSequence < 0
    )
      throw new Error("Invalid lab event cursor");
    this.stream = page.streamId;
    this.sequence = page.latestSequence;
    this.events = [];
    this.complete = true;
  }
  async collect() {
    for (;;) {
      const query = new URLSearchParams({
        afterSequence: String(this.sequence),
        limit: "5000",
        ...(this.stream === undefined ? {} : { streamId: this.stream })
      });
      const page = await this.lab.request(`/api/events/history?${query}`);
      if (
        !record(page) ||
        page.schemaVersion !== 1 ||
        typeof page.streamId !== "string" ||
        typeof page.historyGap !== "boolean" ||
        typeof page.streamChanged !== "boolean" ||
        typeof page.hasMore !== "boolean" ||
        !Array.isArray(page.events)
      )
        throw new Error("Invalid lab event history response");
      if (page.historyGap || page.streamChanged) this.complete = false;
      if (this.stream !== page.streamId) this.sequence = 0;
      this.stream = page.streamId;
      for (const event of page.events) {
        if (
          !record(event) ||
          typeof event.sequence !== "number" ||
          !Number.isSafeInteger(event.sequence) ||
          event.sequence <= this.sequence ||
          typeof event.eventType !== "string"
        )
          throw new Error("Invalid lab event sequence");
        if (this.sequence && event.sequence !== this.sequence + 1) this.complete = false;
        this.sequence = event.sequence;
        if (this.events.length < 100_000) this.events.push(event);
        else this.complete = false;
      }
      if (!page.hasMore) break;
      if (!page.events.length) throw new Error("Lab event history did not advance");
    }
  }
  result() {
    const counts: Record<string, number> = {};
    let airtime = 0;
    let airtimeComplete = this.complete && this.stream !== undefined;
    for (const event of this.events) {
      const kind = String(event.eventType);
      counts[kind] = (counts[kind] ?? 0) + 1;
      if (kind === "rf_transmit") {
        if (typeof event.airtimeMs === "number" && Number.isFinite(event.airtimeMs)) airtime += event.airtimeMs;
        else airtimeComplete = false;
      }
    }
    return {
      scope:
        "Workload observation window, including native background traffic; startup and previous experiments excluded",
      complete: this.complete && this.stream !== undefined,
      stream_id: this.stream ?? null,
      counts,
      rf_airtime_ms: airtimeComplete ? airtime : null,
      native_packet_loss_rate: null,
      native_packet_loss_note:
        "RF injection is not successful firmware reception. Lab history does not expose a complete per-attempt reception denominator; native loss rate is unknown. link_disabled counts topology exclusions, not packet failures.",
      events: this.events
    };
  }
}
