import wrapAnsi from "wrap-ansi";
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

type LogRecord = {
  id: number;
  text: string;
};

type LogDisplayRow = {
  recordId: number;
  rowIndex: number;
  text: string;
};

const MAX_PENDING_FRAGMENT_LENGTH = 64 * 1024;

function boundedFragmentTail(fragment: string): string {
  return fragment.length > MAX_PENDING_FRAGMENT_LENGTH ? fragment.slice(-MAX_PENDING_FRAGMENT_LENGTH) : fragment;
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

  #anchor(): { recordId: number; rowIndex: number } | undefined {
    const row = this.#rows[this.#topRowIndex];
    return row ? { recordId: row.recordId, rowIndex: row.rowIndex } : undefined;
  }

  #rebuild(anchor: { recordId: number; rowIndex: number } | undefined): void {
    this.#rows = this.#records.flatMap((record) => {
      const wrapped = this.#width
        ? wrapAnsi(record.text, this.#width, { hard: true, trim: false }).split("\n")
        : [record.text];
      return wrapped.map((text, rowIndex) => ({ recordId: record.id, rowIndex, text }));
    });
    if (this.#following) {
      this.#moveToLatest();
      return;
    }
    const anchorRows = anchor ? this.#rows.filter(({ recordId }) => recordId === anchor.recordId) : [];
    const translatedAnchor = anchorRows[Math.min(anchor?.rowIndex ?? 0, Math.max(0, anchorRows.length - 1))];
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
  onOutput?: (line: string) => void
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

  const emitLine = (line: string): void => {
    onOutput?.(line);
    if (lineListeners.size === 0) {
      pendingLines.push(line);
      if (pendingLines.length > 200) pendingLines.shift();
    }
    for (const listener of lineListeners) listener(line);
  };
  const frameChunk = (pending: string, chunk: string): string => {
    const lines = `${pending}${chunk}`.split(/\r?\n/u);
    const remainder = lines.pop() ?? "";
    for (const line of lines) emitLine(line);
    return boundedFragmentTail(remainder);
  };
  const emitError = (error: Error): void => {
    for (const listener of errorListeners) listener(error);
  };
  const finish = (error?: Error): void => {
    if (closed) return;
    if (stdoutPending) emitLine(stdoutPending);
    if (stderrPending) emitLine(stderrPending);
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
    stdoutPending = frameChunk(stdoutPending, chunk);
  });
  const removeStderr = source.onStderr((chunk) => {
    stderrPending = frameChunk(stderrPending, chunk);
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
