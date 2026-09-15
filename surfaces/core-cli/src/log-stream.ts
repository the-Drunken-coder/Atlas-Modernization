import wrapAnsi from "wrap-ansi";
import type { LogStream } from "./operator.js";

export type CommandOutputStream = {
  onStdout(listener: (chunk: string) => void): () => void;
  onStderr(listener: (chunk: string) => void): () => void;
  onClose(listener: (result: { cancelled?: true; status: number; stderr: string }) => void): () => void;
  cancel(): void;
  closed: Promise<{ cancelled?: true; status: number; stderr: string }>;
};

type CommandOutputReporter = (stream: "stdout" | "stderr", chunk: string) => void;
const MAX_BUFFERED_COMMAND_OUTPUT_LENGTH = 64 * 1024;

function retainBufferedCommandOutputTail(output: string, chunk: string): string {
  const combined = output + chunk;
  return combined.length > MAX_BUFFERED_COMMAND_OUTPUT_LENGTH
    ? combined.slice(-MAX_BUFFERED_COMMAND_OUTPUT_LENGTH)
    : combined;
}

export function createBufferedCommandOutputStream(
  run: (
    onOutput: CommandOutputReporter
  ) => Promise<{ cancelled?: true; status: number; stdout: string; stderr: string }>,
  cancel: () => void
): CommandOutputStream {
  const stdoutListeners = new Set<(chunk: string) => void>();
  const stderrListeners = new Set<(chunk: string) => void>();
  const closeListeners = new Set<(result: { cancelled?: true; status: number; stderr: string }) => void>();
  let cancellationRequested = false;
  let finalResult: { cancelled?: true; status: number; stderr: string } | undefined;
  let finalOutput: { stdout: string; stderr: string } | undefined;
  let streamedStdout = "";
  let streamedStderr = "";
  let stdoutReported = false;
  let stderrReported = false;
  let settled = false;
  const onOutput: CommandOutputReporter = (stream, chunk) => {
    if (stream === "stdout") {
      stdoutReported = true;
      streamedStdout = retainBufferedCommandOutputTail(streamedStdout, chunk);
      for (const listener of stdoutListeners) listener(chunk);
      return;
    }
    stderrReported = true;
    streamedStderr = retainBufferedCommandOutputTail(streamedStderr, chunk);
    for (const listener of stderrListeners) listener(chunk);
  };
  const settle = (result: { cancelled?: true; status: number; stdout: string; stderr: string }) => {
    settled = true;
    finalOutput = {
      stdout: stdoutReported ? streamedStdout : result.stdout,
      stderr: stderrReported ? streamedStderr : result.stderr
    };
    if (!stdoutReported) for (const listener of stdoutListeners) listener(result.stdout);
    if (!stderrReported) for (const listener of stderrListeners) listener(result.stderr);
    const compact = {
      ...(result.cancelled ? { cancelled: true as const } : {}),
      status: result.status,
      stderr: result.stderr
    };
    finalResult = compact;
    for (const listener of closeListeners) listener(compact);
    stdoutListeners.clear();
    stderrListeners.clear();
    closeListeners.clear();
    return compact;
  };
  let resultPromise: Promise<{ cancelled?: true; status: number; stdout: string; stderr: string }>;
  try {
    resultPromise = run(onOutput);
  } catch (error) {
    resultPromise = Promise.reject(error);
  }
  const closed = resultPromise.then(settle, (error: unknown) =>
    settle({
      ...(cancellationRequested ? { cancelled: true as const } : {}),
      status: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error)
    })
  );
  return {
    onStdout(listener) {
      if (finalOutput) {
        listener(finalOutput.stdout);
        return () => undefined;
      }
      stdoutListeners.add(listener);
      if (streamedStdout) listener(streamedStdout);
      return () => stdoutListeners.delete(listener);
    },
    onStderr(listener) {
      if (finalOutput) {
        listener(finalOutput.stderr);
        return () => undefined;
      }
      stderrListeners.add(listener);
      if (streamedStderr) listener(streamedStderr);
      return () => stderrListeners.delete(listener);
    },
    onClose(listener) {
      if (finalResult) {
        listener(finalResult);
        return () => undefined;
      }
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    cancel() {
      if (settled || cancellationRequested) return;
      cancellationRequested = true;
      cancel();
    },
    closed
  };
}

type LogRecord = {
  id: number;
  text: string;
};

type LogDisplayRow = {
  recordId: number;
  rowIndex: number;
  text: string;
};

const MAX_LOG_LINE_LENGTH = 64 * 1024;
const MAX_DISPLAY_ROWS = 100_000;

function boundedLogLineTail(line: string): string {
  return line.length > MAX_LOG_LINE_LENGTH ? line.slice(-MAX_LOG_LINE_LENGTH) : line;
}

export type LogBufferSnapshot = {
  lines: string[];
  firstLine: number;
  lastLine: number;
  following: boolean;
};

/**
 * Keeps bounded raw log records and a stable display-row viewport.
 * Retaining raw records lets terminal clients rewrap history without reopening the stream.
 */
export class LogBuffer {
  readonly #capacity: number;
  #following = true;
  #nextRecordId = 0;
  #records: LogRecord[] = [];
  #rows: LogDisplayRow[] = [];
  #topRowIndex = 0;
  #viewportRows = 1;
  #width: number | undefined;

  constructor(capacity = 200) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Log buffer capacity must be a positive integer.");
    this.#capacity = capacity;
  }

  get following(): boolean {
    return this.#following;
  }

  get size(): number {
    return this.#records.length;
  }

  setWidth(width: number): void {
    const nextWidth = Math.max(1, Math.floor(width));
    if (nextWidth === this.#width) return;
    const anchor = this.#anchor();
    this.#width = nextWidth;
    this.#rebuild(anchor);
  }

  setViewport(rows: number): void {
    this.#viewportRows = Math.max(1, Math.floor(rows));
    if (this.#following) this.#moveToLatest();
    else this.#clampTop();
  }

  append(text: string): void {
    const anchor = this.#anchor();
    this.#records.push({ id: this.#nextRecordId++, text });
    if (this.#records.length > this.#capacity) this.#records.splice(0, this.#records.length - this.#capacity);
    this.#rebuild(anchor);
  }

  scroll(delta: number): void {
    if (delta === 0) return;
    this.#following = false;
    this.#topRowIndex += Math.trunc(delta);
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
    const firstLine = this.#rows.length === 0 ? 0 : this.#topRowIndex;
    return {
      lines: this.#rows.slice(this.#topRowIndex, this.#topRowIndex + this.#viewportRows).map(({ text }) => text),
      firstLine,
      lastLine: this.#rows.length === 0 ? firstLine : this.#rows.length - 1,
      following: this.#following
    };
  }

  #anchor(): { recordId: number; offset: number } | undefined {
    const row = this.#rows[this.#topRowIndex];
    return row ? { recordId: row.recordId, offset: row.rowIndex * (this.#width ?? 1) } : undefined;
  }

  #rebuild(anchor: { recordId: number; offset: number } | undefined): void {
    const rows: LogDisplayRow[] = [];
    for (
      let recordIndex = this.#records.length - 1;
      recordIndex >= 0 && rows.length < MAX_DISPLAY_ROWS;
      recordIndex -= 1
    ) {
      const record = this.#records[recordIndex];
      if (!record) continue;
      const wrapped = this.#width
        ? wrapAnsi(record.text, this.#width, { hard: true, trim: false }).split("\n")
        : [record.text];
      const firstRow = Math.max(0, wrapped.length - (MAX_DISPLAY_ROWS - rows.length));
      for (let rowIndex = wrapped.length - 1; rowIndex >= firstRow; rowIndex -= 1) {
        const text = wrapped[rowIndex];
        if (text === undefined) continue;
        rows.push({ recordId: record.id, rowIndex, text });
      }
    }
    this.#rows = rows.reverse();
    if (this.#following) {
      this.#moveToLatest();
      return;
    }
    const anchorRows = anchor ? this.#rows.filter(({ recordId }) => recordId === anchor.recordId) : [];
    const targetRowIndex = anchor ? Math.floor(anchor.offset / (this.#width ?? 1)) : 0;
    const translatedAnchor = anchorRows.find(({ rowIndex }) => rowIndex >= targetRowIndex) ?? anchorRows.at(-1);
    if (translatedAnchor) {
      this.#topRowIndex = this.#rows.indexOf(translatedAnchor);
    } else if (anchor) {
      const nextRecordRow = this.#rows.findIndex(({ recordId }) => recordId > anchor.recordId);
      this.#topRowIndex = nextRecordRow >= 0 ? nextRecordRow : Math.max(0, this.#rows.length - 1);
    }
    this.#clampTop();
  }

  #moveToLatest(): void {
    this.#topRowIndex = Math.max(0, this.#rows.length - this.#viewportRows);
  }

  #clampTop(): void {
    const lastTop = Math.max(0, this.#rows.length - this.#viewportRows);
    this.#topRowIndex = Math.max(0, Math.min(lastTop, this.#topRowIndex));
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
  onOutput?: (stream: "stdout" | "stderr", line: string) => void
): LogStream {
  const lineListeners = new Set<(line: string) => void>();
  const pendingLines: string[] = [];
  const errorListeners = new Set<(error: Error) => void>();
  const closeListeners = new Set<(error?: Error) => void>();
  let stdoutPending = "";
  let stderrPending = "";
  let closed = false;
  let terminalError: Error | undefined;
  let closePromise: Promise<void> | undefined;
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  void done.catch(() => undefined);

  const emitLine = (stream: "stdout" | "stderr", line: string): void => {
    onOutput?.(stream, line);
    if (lineListeners.size === 0) {
      pendingLines.push(line);
      if (pendingLines.length > 200) pendingLines.shift();
    }
    for (const listener of lineListeners) listener(line);
  };
  const frameChunk = (stream: "stdout" | "stderr", pending: string, chunk: string): string => {
    const lines = `${pending}${chunk}`.split(/\r?\n/u);
    const remainder = lines.pop() ?? "";
    for (const line of lines) emitLine(stream, boundedLogLineTail(line));
    return boundedLogLineTail(remainder);
  };
  const emitError = (error: Error): void => {
    for (const listener of errorListeners) listener(error);
  };
  const finish = (error?: Error): void => {
    if (closed) return;
    if (stdoutPending) emitLine("stdout", stdoutPending);
    if (stderrPending) emitLine("stderr", stderrPending);
    stdoutPending = "";
    stderrPending = "";
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
    stdoutPending = frameChunk("stdout", stdoutPending, chunk);
  });
  const removeStderr = source.onStderr((chunk) => {
    stderrPending = frameChunk("stderr", stderrPending, chunk);
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
