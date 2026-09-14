import type { LogStream } from "./operator.js";

export type CommandOutputStream = {
  onStdout(listener: (chunk: string) => void): () => void;
  onStderr(listener: (chunk: string) => void): () => void;
  onClose(listener: (result: { cancelled?: true; status: number; stderr: string }) => void): () => void;
  cancel(): void;
  closed: Promise<{ cancelled?: true; status: number; stderr: string }>;
};

export function createBufferedCommandOutputStream(
  resultPromise: Promise<{ cancelled?: true; status: number; stdout: string; stderr: string }>
): CommandOutputStream {
  const stdoutListeners = new Set<(chunk: string) => void>();
  const stderrListeners = new Set<(chunk: string) => void>();
  const closeListeners = new Set<(result: { cancelled?: true; status: number; stderr: string }) => void>();
  const closed = resultPromise.then((result) => {
    for (const listener of stdoutListeners) listener(result.stdout);
    for (const listener of stderrListeners) listener(result.stderr);
    const compact = {
      ...(result.cancelled ? { cancelled: true as const } : {}),
      status: result.status,
      stderr: result.stderr
    };
    for (const listener of closeListeners) listener(compact);
    return compact;
  });
  return {
    onStdout(listener) {
      stdoutListeners.add(listener);
      return () => stdoutListeners.delete(listener);
    },
    onStderr(listener) {
      stderrListeners.add(listener);
      return () => stderrListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      void closed.then((result) => listener(result));
      return () => closeListeners.delete(listener);
    },
    cancel() {
      // The wrapped runner remains responsible for cancellation.
    },
    closed
  };
}

type LogLine = {
  id: number;
  text: string;
};

export type LogBufferSnapshot = {
  lines: string[];
  firstLine: number;
  lastLine: number;
  following: boolean;
};

/**
 * Keeps a bounded stream of complete log lines and a stable paused viewport.
 * Line ids make eviction independent from the display width and wrapping.
 */
export class LogBuffer {
  readonly #capacity: number;
  #lines: LogLine[] = [];
  #nextId = 0;
  #viewportRows = 1;
  #topLineId = 0;
  #following = true;

  constructor(capacity = 200) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Log buffer capacity must be a positive integer.");
    this.#capacity = capacity;
  }

  get following(): boolean {
    return this.#following;
  }

  get size(): number {
    return this.#lines.length;
  }

  setViewport(rows: number): void {
    this.#viewportRows = Math.max(1, Math.floor(rows));
    if (this.#following) this.#moveToLatest();
    else this.#clampTop();
  }

  append(line: string): void {
    const wasFollowing = this.#following;
    const pausedAnchor = this.#lines[this.#topIndex()]?.id;
    this.#lines.push({ id: this.#nextId++, text: line });
    if (this.#lines.length > this.#capacity) this.#lines.splice(0, this.#lines.length - this.#capacity);
    if (wasFollowing) this.#moveToLatest();
    else {
      this.#topLineId = pausedAnchor ?? this.#lines[0]?.id ?? 0;
      this.#clampTop();
    }
  }

  scroll(delta: number): void {
    if (delta === 0) return;
    this.#following = false;
    this.#topLineId += Math.trunc(delta);
    this.#clampTop();
  }

  toggleFollowing(): void {
    this.#following = !this.#following;
    if (this.#following) this.#moveToLatest();
    else this.#clampTop();
  }

  followLatest(): void {
    this.#following = true;
    this.#moveToLatest();
  }

  snapshot(): LogBufferSnapshot {
    const first = this.#lines[0]?.id ?? 0;
    const topIndex = this.#topIndex();
    const visible = this.#lines.slice(topIndex, topIndex + this.#viewportRows).map(({ text }) => text);
    return {
      lines: visible,
      firstLine: this.#lines[0]?.id ?? first,
      lastLine: this.#lines.at(-1)?.id ?? first,
      following: this.#following
    };
  }

  #topIndex(): number {
    const first = this.#lines[0]?.id;
    if (first === undefined) return 0;
    return Math.max(0, Math.min(this.#lines.length - 1, this.#topLineId - first));
  }

  #moveToLatest(): void {
    this.#topLineId = Math.max(0, (this.#lines.at(-1)?.id ?? 0) - this.#viewportRows + 1);
  }

  #clampTop(): void {
    const first = this.#lines[0]?.id ?? 0;
    const lastTop = Math.max(first, (this.#lines.at(-1)?.id ?? first) - this.#viewportRows + 1);
    this.#topLineId = Math.max(first, Math.min(lastTop, this.#topLineId));
  }
}

/**
 * Adapts a captured child-process stream to the headless operator contract.
 * Docker emits arbitrary chunks, so this adapter owns newline framing and
 * never exposes a partially written line to the TUI.
 */
export function createLogStream(
  service: LogStream["service"],
  source: CommandOutputStream,
  onOutput?: (line: string) => void
): LogStream {
  const lineListeners = new Set<(line: string) => void>();
  const pendingLines: string[] = [];
  const errorListeners = new Set<(error: Error) => void>();
  const closeListeners = new Set<(error?: Error) => void>();
  let pending = "";
  let closed = false;
  let terminalError: Error | undefined;
  let closePromise: Promise<void> | undefined;
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const emitLine = (line: string): void => {
    onOutput?.(line);
    if (lineListeners.size === 0) {
      pendingLines.push(line);
      if (pendingLines.length > 200) pendingLines.shift();
    }
    for (const listener of lineListeners) listener(line);
  };
  const emitError = (error: Error): void => {
    for (const listener of errorListeners) listener(error);
  };
  const finish = (error?: Error): void => {
    if (closed) return;
    if (pending) {
      emitLine(pending);
      pending = "";
    }
    closed = true;
    terminalError = error;
    if (error) {
      emitError(error);
      rejectDone(error);
    } else resolveDone();
    for (const listener of closeListeners) listener(error);
    lineListeners.clear();
    errorListeners.clear();
    closeListeners.clear();
  };
  const removeStdout = source.onStdout((chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) emitLine(line);
  });
  const removeStderr = source.onStderr((chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) emitLine(line);
  });
  source.onClose((result) => {
    removeStdout();
    removeStderr();
    if (result.status !== 0 && !result.cancelled) {
      finish(
        new Error(
          `docker compose logs failed with exit code ${result.status}: ${result.stderr.trim() || "no diagnostic"}`
        )
      );
    } else finish();
  });

  return {
    service,
    onLine(listener) {
      lineListeners.add(listener);
      for (const line of pendingLines.splice(0)) listener(line);
      if (closed) return () => undefined;
      return () => lineListeners.delete(listener);
    },
    onError(listener) {
      if (terminalError) listener(terminalError);
      if (closed) return () => undefined;
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    onClose(listener) {
      if (closed) {
        listener(terminalError);
        return () => undefined;
      }
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    wait() {
      return done;
    },
    async close() {
      if (!closePromise) {
        source.cancel();
        closePromise = done.catch(() => undefined);
      }
      await closePromise;
    }
  };
}
