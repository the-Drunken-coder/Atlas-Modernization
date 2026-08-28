import type { RunEvent } from "../shared/types.js";
import { parseRunEvent } from "./run-state.js";

type RunEventStreamCallbacks = {
  onEvent: (event: RunEvent) => boolean | void;
  onInvalidEvent: (error: Error) => void;
  onConnectionError: () => void;
};

export class RunEventStream {
  private source: EventSource | undefined;
  private activeRunId: string | undefined;

  get runId(): string | undefined {
    return this.activeRunId;
  }

  connect(runId: string, callbacks: RunEventStreamCallbacks): void {
    this.close();
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
    this.source = source;
    this.activeRunId = runId;

    source.onmessage = (message) => {
      if (!this.isActive(source, runId)) return;
      let event: RunEvent;
      try {
        event = parseRunEvent(JSON.parse(message.data));
      } catch {
        callbacks.onInvalidEvent(new Error(`Invalid event payload for run ${runId}`));
        this.closeIfActive(source, runId);
        return;
      }
      if (event.runId !== runId) {
        callbacks.onInvalidEvent(new Error(`Received event for ${event.runId} on stream for ${runId}`));
        this.closeIfActive(source, runId);
        return;
      }
      if (callbacks.onEvent(event)) this.closeIfActive(source, runId);
    };
    source.onerror = () => {
      if (this.isActive(source, runId)) callbacks.onConnectionError();
    };
  }

  close(): void {
    const source = this.source;
    this.source = undefined;
    this.activeRunId = undefined;
    source?.close();
  }

  private isActive(source: EventSource, runId: string): boolean {
    return this.source === source && this.activeRunId === runId;
  }

  private closeIfActive(source: EventSource, runId: string): void {
    if (this.isActive(source, runId)) this.close();
  }
}
