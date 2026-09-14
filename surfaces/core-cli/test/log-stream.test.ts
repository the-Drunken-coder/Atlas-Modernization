import { describe, expect, it } from "vitest";
import { type CommandOutputStream, createLogStream, LogBuffer } from "../src/log-stream.js";

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

  it("frames split output and reports a failed controlled stream", async () => {
    const fixture = source();
    const stream = createLogStream("api", fixture.stream);
    const lines: string[] = [];
    const errors: Error[] = [];
    stream.onLine((line) => lines.push(line));
    stream.onError((error) => errors.push(error));
    fixture.stdout("first\nsecond");
    fixture.stderr("\nthird");
    fixture.close({ status: 17, stderr: "unavailable" });

    await expect(stream.wait()).rejects.toThrow("exit code 17");
    expect(lines).toEqual(["first", "second", "third"]);
    expect(errors).toHaveLength(1);
  });
});
