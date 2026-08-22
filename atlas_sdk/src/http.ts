import { sanitizeErrorMessage } from "./error-sanitizer.js";
import { parseAtlasJSON, stringifyAtlasJSON } from "./json.js";
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

  constructor(message: string, status: number, response: unknown) {
    const safeResponse = safeErrorPayload(response);
    super(sanitizeErrorMessage(message));
    this.name = "AtlasAPIError";
    this.status = status;
    this.response = safeResponse;
    this.errorCode = errorCodeFromPayload(safeResponse);
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
    const response = await this.raw(method, path, body, ifMatchVersion, signal, requestHeaders);
    const value = await readSuccessfulJSON(response, signal);
    if (!validate(value)) {
      throw new TypeError(`Atlas response failed validation for ${method} ${path}`);
    }
    return value;
  }

  async versionedJSON<T>(
    method: string,
    path: string,
    validate: ResponseValidator<T>,
    body?: unknown,
    signal?: AbortSignal,
    requestHeaders?: HeadersInit
  ): Promise<VersionedResponse<T>> {
    const response = await this.raw(method, path, body, undefined, signal, requestHeaders);
    const value = await readSuccessfulJSON(response, signal);
    if (!validate(value)) {
      throw new TypeError(`Atlas response failed validation for ${method} ${path}`);
    }
    const version = strongETagVersion(response.headers.get("ETag"));
    if (version === undefined) {
      throw new TypeError(`Atlas response did not include a valid resource ETag for ${method} ${path}`);
    }
    return { value, version };
  }

  async empty(
    method: string,
    path: string,
    body?: unknown,
    ifMatchVersion?: number,
    signal?: AbortSignal,
    requestHeaders?: HeadersInit
  ): Promise<void> {
    const response = await this.raw(method, path, body, ifMatchVersion, signal, requestHeaders);
    if (response.status !== 204) {
      throw new TypeError(`Atlas response failed validation for ${method} ${path}`);
    }
  }

  async arrayBuffer(method: string, path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const response = await this.raw(method, path, undefined, undefined, signal);
    try {
      return await response.arrayBuffer();
    } catch (error) {
      throwTransportBodyError(error, signal);
    }
  }

  async raw(
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
    const response = await this.fetchWithTimeout(joinAtlasUrl(this.baseUrl, path), {
      method,
      headers,
      credentials: this.credentials,
      body: body === undefined ? undefined : stringifyAtlasJSON(body),
      signal
    });
    if (!response.ok) {
      const payload = safeErrorPayload(await readErrorPayload(response, signal));
      const message = errorMessage(response.status, payload);
      if (response.status === 409 || response.status === 412) {
        throw new ConflictError(message, response.status, payload);
      }
      throw new AtlasAPIError(message, response.status, payload);
    }
    return response;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const requestSignal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: requestSignal
      });
    } catch (error) {
      if (init.signal?.aborted && requestSignal.reason === init.signal.reason) {
        throw init.signal.reason;
      }
      if (controller.signal.aborted) {
        throw new AtlasTransportError(`Atlas request timed out after ${this.requestTimeoutMs}ms`);
      }
      const message = sanitizeErrorMessage(error);
      if (isAtlasTransportError(error)) throw error;
      throw new AtlasTransportError(message);
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readSuccessfulJSON(response: Response, signal?: AbortSignal): Promise<unknown> {
  let serialized: string;
  try {
    serialized = await response.text();
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
    return parseAtlasJSON(await response.text());
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
  return {
    ...(success === undefined ? {} : { success }),
    ...(fields.error_code === undefined ? {} : { error_code: fields.error_code }),
    ...(fields.message === undefined ? {} : { message: sanitizeErrorMessage(fields.message) })
  };
}
