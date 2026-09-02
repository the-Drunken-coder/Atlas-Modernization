import { sanitizeErrorDetails, sanitizeErrorMessage } from "./error-sanitizer.js";
import { parseAtlasJSON, stringifyAtlasJSON } from "./json.js";
import type { JSONValue } from "./protocol.js";
import { isTimerDelayInRange, MAX_TIMER_DELAY_MS } from "./timer.js";
import type { FetchLike } from "./types.js";
import { joinAtlasUrl, normalizeAtlasBaseUrl } from "./url.js";

export type ResponseValidator<T> = (value: unknown) => value is T;

export type VersionedResponse<T> = {
  value: T;
  version: number;
};

export type HttpTransportOptions = {
  baseUrl: string;
  apiKey?: string;
  credentials?: RequestCredentials;
  fetchImpl: FetchLike;
  requestTimeoutMs: number;
};

const ATLAS_API_ERROR_CODE = "ATLAS_API_ERROR";

export class AtlasAPIError extends Error {
  readonly code = ATLAS_API_ERROR_CODE;
  readonly status: number;
  readonly response: unknown;
  readonly errorCode?: string;
  readonly details?: JSONValue;

  constructor(message: string, status: number, response: unknown) {
    const safeResponse = safeErrorPayload(response);
    super(sanitizeErrorMessage(message));
    this.name = "AtlasAPIError";
    this.status = status;
    this.response = safeResponse;
    this.errorCode = errorCodeFromPayload(safeResponse);
    this.details = errorDetailsFromPayload(safeResponse);
  }
}

export class ConflictError extends AtlasAPIError {
  constructor(message: string, status: number, response: unknown) {
    super(message, status, response);
    this.name = "ConflictError";
  }
}

const ATLAS_TRANSPORT_ERROR_CODE = "ATLAS_TRANSPORT_ERROR";

export class AtlasTransportError extends Error {
  readonly code = ATLAS_TRANSPORT_ERROR_CODE;

  constructor(message: string) {
    super(sanitizeErrorMessage(message));
    this.name = "AtlasTransportError";
  }
}

export function isAtlasTransportError(
  error: unknown
): error is { readonly code: "ATLAS_TRANSPORT_ERROR"; readonly message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    "code" in error &&
    error.code === ATLAS_TRANSPORT_ERROR_CODE
  );
}

export function isAtlasAPIError(
  error: unknown
): error is { readonly code: "ATLAS_API_ERROR"; readonly message: string; readonly status: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    "status" in error &&
    typeof error.status === "number" &&
    "code" in error &&
    error.code === ATLAS_API_ERROR_CODE
  );
}

export class HttpTransport {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly credentials?: RequestCredentials;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;

  constructor(options: HttpTransportOptions) {
    this.baseUrl = normalizeAtlasBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.credentials = options.credentials;
    this.fetchImpl = options.fetchImpl;
    if (!isTimerDelayInRange(options.requestTimeoutMs)) {
      throw new Error(
        `Atlas request timeout must be a positive finite number of milliseconds no greater than ${MAX_TIMER_DELAY_MS}`
      );
    }
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  async json<T>(
    method: string,
    path: string,
    validate: ResponseValidator<T>,
    body?: unknown,
    ifMatchVersion?: number,
    signal?: AbortSignal,
    requestHeaders?: HeadersInit
  ): Promise<T> {
    return this.withRequestTimeout(signal, async (requestSignal) => {
      const response = await this.raw(method, path, body, ifMatchVersion, requestSignal, requestHeaders);
      const value = await readSuccessfulJSON(response, requestSignal);
      requestSignal.throwIfAborted();
      if (!validate(value)) {
        throw new TypeError(`Atlas response failed validation for ${method} ${path}`);
      }
      return value;
    });
  }

  async versionedJSON<T>(
    method: string,
    path: string,
    validate: ResponseValidator<T>,
    body?: unknown,
    signal?: AbortSignal,
    requestHeaders?: HeadersInit
  ): Promise<VersionedResponse<T>> {
    return this.withRequestTimeout(signal, async (requestSignal) => {
      const response = await this.raw(method, path, body, undefined, requestSignal, requestHeaders);
      const value = await readSuccessfulJSON(response, requestSignal);
      requestSignal.throwIfAborted();
      if (!validate(value)) {
        throw new TypeError(`Atlas response failed validation for ${method} ${path}`);
      }
      const version = strongETagVersion(response.headers.get("ETag"));
      if (version === undefined) {
        throw new TypeError(`Atlas response did not include a valid resource ETag for ${method} ${path}`);
      }
      return { value, version };
    });
  }

  async empty(
    method: string,
    path: string,
    body?: unknown,
    ifMatchVersion?: number,
    signal?: AbortSignal,
    requestHeaders?: HeadersInit
  ): Promise<void> {
    await this.withRequestTimeout(signal, async (requestSignal) => {
      const response = await this.raw(method, path, body, ifMatchVersion, requestSignal, requestHeaders);
      requestSignal.throwIfAborted();
      if (response.status !== 204) {
        throw new TypeError(`Atlas response failed validation for ${method} ${path}`);
      }
    });
  }

  async arrayBuffer(method: string, path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    return this.withRequestTimeout(signal, async (requestSignal) => {
      const response = await this.raw(method, path, undefined, undefined, requestSignal);
      try {
        requestSignal.throwIfAborted();
        const body = await response.arrayBuffer();
        requestSignal.throwIfAborted();
        return body;
      } catch (error) {
        throwTransportBodyError(error, requestSignal);
      }
    });
  }

  private async raw(
    method: string,
    path: string,
    body?: unknown,
    ifMatchVersion?: number,
    signal?: AbortSignal,
    requestHeaders?: HeadersInit
  ): Promise<Response> {
    const headers = new Headers(requestHeaders);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (this.apiKey) headers.set("X-API-Key", this.apiKey);
    if (ifMatchVersion !== undefined) headers.set("If-Match", `"v${ifMatchVersion}"`);
    const response = await this.fetchRequest(joinAtlasUrl(this.baseUrl, path), {
      method,
      headers,
      credentials: this.credentials,
      body: body === undefined ? undefined : stringifyAtlasJSON(body),
      signal
    });
    signal?.throwIfAborted();
    if (!response.ok) {
      const payload = safeErrorPayload(await readErrorPayload(response, signal));
      signal?.throwIfAborted();
      const message = errorMessage(response.status, payload);
      if (response.status === 409 || response.status === 412) {
        throw new ConflictError(message, response.status, payload);
      }
      throw new AtlasAPIError(message, response.status, payload);
    }
    return response;
  }

  private async fetchRequest(url: string, init: RequestInit): Promise<Response> {
    try {
      const response = await this.fetchImpl(url, init);
      init.signal?.throwIfAborted();
      return response;
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason;
      const message = sanitizeErrorMessage(error);
      if (isAtlasTransportError(error)) throw error;
      throw new AtlasTransportError(message);
    }
  }

  private async withRequestTimeout<T>(
    signal: AbortSignal | undefined,
    operation: (requestSignal: AbortSignal) => Promise<T>
  ): Promise<T> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const abortRequest = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort?.(requestSignal.reason);
    requestSignal.addEventListener("abort", onAbort, { once: true });
    if (requestSignal.aborted) onAbort();
    try {
      const result = await Promise.race([operation(requestSignal), abortRequest]);
      requestSignal.throwIfAborted();
      return result;
    } catch (error) {
      if (signal?.aborted && requestSignal.reason === signal.reason) {
        throw signal.reason;
      }
      if (controller.signal.aborted) {
        throw new AtlasTransportError(`Atlas request timed out after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      requestSignal.removeEventListener("abort", onAbort);
    }
  }
}

async function readSuccessfulJSON(response: Response, signal?: AbortSignal): Promise<unknown> {
  let serialized: string;
  try {
    signal?.throwIfAborted();
    serialized = await response.text();
    signal?.throwIfAborted();
  } catch (error) {
    throwTransportBodyError(error, signal);
  }
  return parseAtlasJSON(serialized);
}

function throwTransportBodyError(error: unknown, signal?: AbortSignal): never {
  if (signal?.aborted) throw signal.reason;
  if (isAtlasTransportError(error)) throw error;
  throw new AtlasTransportError(sanitizeErrorMessage(error));
}

function strongETagVersion(etag: string | null): number | undefined {
  const match = /^"v([1-9][0-9]*)"$/.exec(etag ?? "");
  if (!match) return undefined;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? version : undefined;
}

async function readErrorPayload(response: Response, signal?: AbortSignal): Promise<unknown> {
  try {
    signal?.throwIfAborted();
    const serialized = await response.text();
    signal?.throwIfAborted();
    return parseAtlasJSON(serialized);
  } catch {
    if (signal?.aborted) throw signal.reason;
    return undefined;
  }
}

function errorMessage(status: number, payload: unknown): string {
  const response = errorResponseFields(payload);
  const code = response?.error_code;
  const message = response?.message;
  if (code && message) {
    return `Atlas request failed: ${status} ${code}: ${message}`;
  }
  if (message) {
    return `Atlas request failed: ${status}: ${message}`;
  }
  return `Atlas request failed: ${status}`;
}

function errorCodeFromPayload(payload: unknown): string | undefined {
  return errorResponseFields(payload)?.error_code;
}

function errorDetailsFromPayload(payload: unknown): JSONValue | undefined {
  if (typeof payload !== "object" || payload === null || !("details" in payload)) return undefined;
  return sanitizeErrorDetails(payload.details);
}

function errorResponseFields(payload: unknown): { error_code?: string; message?: string } | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const errorCode =
    "error_code" in payload &&
    typeof payload.error_code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(payload.error_code)
      ? payload.error_code
      : undefined;
  const message = "message" in payload && typeof payload.message === "string" ? payload.message : undefined;
  return {
    ...(errorCode === undefined ? {} : { error_code: errorCode }),
    ...(message === undefined ? {} : { message })
  };
}

function safeErrorPayload(payload: unknown): unknown {
  const fields = errorResponseFields(payload);
  if (!fields) return undefined;
  const success =
    typeof payload === "object" && payload !== null && "success" in payload && payload.success === false
      ? false
      : undefined;
  const details =
    typeof payload === "object" && payload !== null && "details" in payload
      ? sanitizeErrorDetails(payload.details)
      : undefined;
  return {
    ...(success === undefined ? {} : { success }),
    ...(fields.error_code === undefined ? {} : { error_code: fields.error_code }),
    ...(fields.message === undefined ? {} : { message: sanitizeErrorMessage(fields.message) }),
    ...(details === undefined ? {} : { details })
  };
}
