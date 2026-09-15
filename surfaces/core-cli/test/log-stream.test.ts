import { describe, expect, it } from "vitest";
import {
  type CommandOutputStream,
  createBufferedCommandOutputStream,
  createLogStream,
  LogBuffer
} from "../src/log-stream.js";

function source(): {
  stream: CommandOutputStream;
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  close(result?: { cancelled?: true; status?: number; stderr?: string }): void;
} {
  const stdoutListeners = new Set<(chunk: string) => void>();
  const stderrListeners = new Set<(chunk: string) => void>();
  const closeListeners = new Set<(result: { cancelled?: true; status: number; stderr: string }) => void>();
  let resolveClosed!: (result: { cancelled?: true; status: number; stderr: string }) => void;
  const closed = new Promise<{ cancelled?: true; status: number; stderr: string }>((resolve) => {
    resolveClosed = resolve;
  });
  const stream: CommandOutputStream = {
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
      return () => closeListeners.delete(listener);
    },
    cancel() {
      resolveClosed({ cancelled: true, status: 0, stderr: "" });
    },
    closed
  };
  return {
    stream,
    stdout: (chunk) => stdoutListeners.forEach((listener) => listener(chunk)),
    stderr: (chunk) => stderrListeners.forEach((listener) => listener(chunk)),
    close: (result = {}) => {
      const closedResult = {
        ...(result.cancelled ? { cancelled: true as const } : {}),
        status: result.status ?? 0,
        stderr: result.stderr ?? ""
      };
      resolveClosed(closedResult);
      closeListeners.forEach((listener) => listener(closedResult));
    }
  };
}

describe("log stream primitives", () => {
  it("replays output when a buffered command finishes before the log stream subscribes", async () => {
    const source = createBufferedCommandOutputStream(
      Promise.resolve({ status: 0, stdout: "fast output\n", stderr: "" }),
      () => undefined
    );
    await source.closed;
    const stream = createLogStream("api", source);
    const lines: string[] = [];
    stream.onLine((line) => lines.push(line));

    await stream.wait();

    expect(lines).toEqual(["fast output"]);
  });

  it("reports a buffered runner rejection instead of leaving the stream pending", async () => {
    const stream = createLogStream(
      "api",
      createBufferedCommandOutputStream(Promise.reject(new Error("runner failed")), () => undefined)
    );

    await expect(stream.wait()).rejects.toThrow("runner failed");
    await stream.close();
  });

  it("treats a buffered runner rejection after close as cancellation", async () => {
    let rejectRun!: (error: Error) => void;
    const result = new Promise<never>((_resolve, reject) => {
      rejectRun = reject;
    });
    let cancellations = 0;
    const stream = createLogStream(
      "api",
      createBufferedCommandOutputStream(result, () => {
        cancellations++;
        rejectRun(new Error("aborted"));
      })
    );

    await stream.close();
    await expect(stream.wait()).resolves.toBeUndefined();
    expect(cancellations).toBe(1);
  });

  it("bounds output and preserves a paused anchor until eviction", () => {
    const buffer = new LogBuffer(3);
    buffer.setViewport(2);
    buffer.append("one");
    buffer.append("two");
    buffer.append("three");
    buffer.scroll(-1);
    expect(buffer.snapshot()).toMatchObject({ lines: ["one", "two"], following: false });

    buffer.append("four");
    expect(buffer.snapshot()).toMatchObject({ lines: ["two", "three"], following: false });
    buffer.append("five");
    expect(buffer.snapshot()).toMatchObject({ lines: ["three", "four"], following: false });
    expect(buffer.size).toBe(3);
  });

  it("follows new output and jumps to the latest line", () => {
    const buffer = new LogBuffer(10);
    buffer.setViewport(2);
    buffer.append("one");
    buffer.append("two");
    buffer.append("three");
    expect(buffer.snapshot()).toMatchObject({ lines: ["two", "three"], following: true });
    buffer.scroll(-1);
    buffer.append("four");
    expect(buffer.snapshot()).toMatchObject({ lines: ["one", "two"], following: false });
    buffer.followLatest();
    expect(buffer.snapshot()).toMatchObject({ lines: ["three", "four"], following: true });

    for (let index = 0; index < 12; index += 1) buffer.append(`line-${index}`);
    expect(buffer.size).toBe(10);
    expect(buffer.snapshot()).toMatchObject({ lines: ["line-10", "line-11"], following: true });
  });

  it("rewraps retained records while preserving following and paused display-row navigation", () => {
    const buffer = new LogBuffer(10);
    buffer.setWidth(8);
    buffer.setViewport(2);
    buffer.append("abcdefgh1234");
    buffer.append("newest");
    expect(buffer.snapshot()).toMatchObject({ lines: ["1234", "newest"], following: true });

    buffer.toggleFollowing();
    buffer.setWidth(4);
    expect(buffer.snapshot()).toMatchObject({ lines: ["1234", "newe"], following: false });
    buffer.scroll(-1);
    expect(buffer.snapshot()).toMatchObject({ lines: ["efgh", "1234"], following: false });
  });

  it("preserves the paused logical character offset when rewrapping from 80 to 40 columns", () => {
    const buffer = new LogBuffer(10);
    buffer.setWidth(80);
    buffer.setViewport(2);
    buffer.append(`${"a".repeat(80)}${"b".repeat(80)}${"c".repeat(20)}`);
    buffer.append("newest");
    buffer.scroll(-1);
    expect(buffer.snapshot()).toMatchObject({ lines: ["b".repeat(80), "c".repeat(20)], following: false });

    buffer.setWidth(40);
    expect(buffer.snapshot()).toMatchObject({ lines: ["b".repeat(40), "b".repeat(40)], following: false });
  });

  it("bounds materialized display rows for large retained records", () => {
    const buffer = new LogBuffer(200);
    buffer.setViewport(1);
    const record = "x".repeat(64 * 1024);

    for (let index = 0; index < 200; index += 1) buffer.append(record);
    buffer.setWidth(1);

    const snapshot = buffer.snapshot();
    expect(buffer.size).toBe(200);
    expect(snapshot.lines).toEqual(["x"]);
    expect(snapshot.lastLine).toBeLessThanOrEqual(100_000);
  });

  it("frames split output and reports a failed controlled stream", async () => {
    const fixture = source();
    const stream = createLogStream("api", fixture.stream);
    const lines: string[] = [];
    const errors: Error[] = [];
    stream.onLine((line) => lines.push(line));
    stream.onError((error) => errors.push(error));
    fixture.stdout("first\nsecond");
    fixture.stderr("third");
    fixture.close({ status: 17, stderr: "unavailable" });

    await expect(stream.wait()).rejects.toThrow("exit code 17");
    expect(lines).toEqual(["first", "second", "third"]);
    expect(errors).toHaveLength(1);
  });

  it("does not leave an early source failure unhandled before wait is observed", async () => {
    const fixture = source();
    const stream = createLogStream("api", fixture.stream);
    fixture.close({ status: 17, stderr: "unavailable" });

    await new Promise<void>((resolve) => setImmediate(resolve));
    const waitPromise = stream.wait();
    expect(stream.wait()).toBe(waitPromise);
    await expect(waitPromise).rejects.toThrow("exit code 17");
  });

  it("keeps stdout and stderr partial lines independent", async () => {
    const fixture = source();
    const stream = createLogStream("api", fixture.stream);
    const lines: string[] = [];
    stream.onLine((line) => lines.push(line));

    fixture.stdout("partial");
    fixture.stderr("warning\n");
    fixture.stdout(" tail\n");

    expect(lines).toEqual(["warning", "partial tail"]);
    fixture.close();
    await stream.wait();
  });

  it("bounds an unterminated partial line while retaining its tail", async () => {
    const fixture = source();
    const stream = createLogStream("api", fixture.stream);
    const lines: string[] = [];
    stream.onLine((line) => lines.push(line));
    const longLine = `prefix-${"x".repeat(128 * 1024)}`;

    fixture.stdout(longLine);
    fixture.close();
    await stream.wait();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(64 * 1024);
    expect(lines[0]).toBe(longLine.slice(-64 * 1024));
  });

  it("bounds a newline-terminated record while retaining its tail", async () => {
    const fixture = source();
    const stream = createLogStream("api", fixture.stream);
    const lines: string[] = [];
    stream.onLine((line) => lines.push(line));
    const longLine = `prefix-${"x".repeat(128 * 1024)}`;

    fixture.stdout(`${longLine}\n`);
    fixture.close();
    await stream.wait();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(64 * 1024);
    expect(lines[0]).toBe(longLine.slice(-64 * 1024));
  });
});
