import type { CommandSubmitRequest, CommandSubmitResponse, APIErrorResponse } from "./command-model.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type AtlasCommandConfig = {
  atlasBaseUrl: string;
  protocolRevision: string;
};

export type CommandAPIOptions = {
  commandApiKey?: string;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
};

export class CommandAPIError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: APIErrorResponse["details"];

  constructor(status: number, body: APIErrorResponse) {
    super(body.message);
    this.name = "CommandAPIError";
    this.status = status;
    this.code = body.error_code;
    this.details = body.details;
  }
}

export async function fetchCommandConfig(options: Pick<CommandAPIOptions, "requestTimeoutMs" | "signal"> = {}): Promise<AtlasCommandConfig> {
  return await requestJSON<AtlasCommandConfig>("/api/config", {
    headers: { Accept: "application/json" },
    requestTimeoutMs: options.requestTimeoutMs,
    signal: options.signal
  });
}

export async function submitCommand(request: CommandSubmitRequest, options: CommandAPIOptions = {}): Promise<CommandSubmitResponse> {
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json"
  });
  if (options.commandApiKey) {
    headers.set("Authorization", `Bearer ${options.commandApiKey}`);
  }
  return await requestJSON<CommandSubmitResponse>("/api/commands", {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    requestTimeoutMs: options.requestTimeoutMs,
    signal: options.signal
  });
}

async function requestJSON<T>(
  input: RequestInfo | URL,
  init: RequestInit & { requestTimeoutMs?: number }
): Promise<T> {
  const { requestTimeoutMs, signal: callerSignal, ...requestInit } = init;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  try {
    return await readJSON<T>(
      await fetch(input, {
        ...requestInit,
        signal: combineAbortSignals(callerSignal, controller.signal)
      })
    );
  } catch (error) {
    if (error instanceof CommandAPIError) {
      throw error;
    }
    const requestAborted = isAbortError(error);
    throw new CommandAPIError(0, {
      success: false,
      error_code: requestAborted ? (timedOut ? "REQUEST_TIMEOUT" : "REQUEST_ABORTED") : "NETWORK_ERROR",
      message: requestAborted ? (timedOut ? "Command API request timed out" : "Command API request was aborted") : "Command API request failed",
      details: { cause: errorMessage(error) }
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJSON<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new CommandAPIError(response.status, {
      success: false,
      error_code: "INVALID_RESPONSE",
      message: "Command API returned invalid JSON",
      details: { cause: errorMessage(error) }
    });
  }
  if (!response.ok) {
    throw new CommandAPIError(response.status, apiErrorResponse(body, response.status));
  }
  return body as T;
}

function apiErrorResponse(value: unknown, status: number): APIErrorResponse {
  if (isRecord(value) && typeof value.error_code === "string" && typeof value.message === "string") {
    return {
      success: false,
      error_code: value.error_code,
      message: value.message,
      details: isRecord(value.details) ? (value.details as APIErrorResponse["details"]) : {}
    };
  }
  return {
    success: false,
    error_code: "INVALID_RESPONSE",
    message: `Command API returned malformed error response (${status})`,
    details: {}
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function combineAbortSignals(callerSignal: AbortSignal | null | undefined, timeoutSignal: AbortSignal): AbortSignal {
  if (!callerSignal) return timeoutSignal;
  return AbortSignal.any([callerSignal, timeoutSignal]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
