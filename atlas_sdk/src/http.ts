import { sanitizeErrorMessage } from "./error-sanitizer.js";
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

export class AtlasAPIError extends Error {
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

export class AtlasTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtlasTransportError";
  }
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
    const value: unknown = await response.json();
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
    const value: unknown = await response.json();
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
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    });
    if (!response.ok) {
      const payload = safeErrorPayload(await readErrorPayload(response));
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
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AtlasTransportError(`Atlas request timed out after ${this.requestTimeoutMs}ms`);
      }
      const message = sanitizeErrorMessage(error);
      if (error instanceof AtlasTransportError) throw error;
      throw new AtlasTransportError(message);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function strongETagVersion(etag: string | null): number | undefined {
  const match = /^"v([1-9][0-9]*)"$/.exec(etag ?? "");
  if (!match) return undefined;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? version : undefined;
}

async function readErrorPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
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
