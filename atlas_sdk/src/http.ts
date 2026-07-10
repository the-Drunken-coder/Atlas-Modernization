import type { FetchLike } from "./types.js";

export type ResponseValidator<T> = (value: unknown) => value is T;

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
    super(message);
    this.name = "AtlasAPIError";
    this.status = status;
    this.response = response;
    this.errorCode = errorCodeFromPayload(response);
  }
}

export class ConflictError extends AtlasAPIError {
  constructor(message: string, status: number, response: unknown) {
    super(message, status, response);
    this.name = "ConflictError";
  }
}

export class HttpTransport {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly credentials?: RequestCredentials;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;

  constructor(options: HttpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.credentials = options.credentials;
    this.fetchImpl = options.fetchImpl;
    if (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) {
      throw new Error("Atlas request timeout must be a positive finite number of milliseconds");
    }
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  async json<T>(method: string, path: string, validate: ResponseValidator<T>, body?: unknown, ifMatchVersion?: number): Promise<T> {
    const response = await this.raw(method, path, body, ifMatchVersion);
    const value: unknown = await response.json();
    if (!validate(value)) {
      throw new TypeError(`Atlas response failed validation for ${method} ${path}`);
    }
    return value;
  }

  async empty(method: string, path: string, body?: unknown, ifMatchVersion?: number): Promise<void> {
    const response = await this.raw(method, path, body, ifMatchVersion);
    if (response.status !== 204) {
      throw new TypeError(`Atlas response failed validation for ${method} ${path}`);
    }
  }

  async raw(method: string, path: string, body?: unknown, ifMatchVersion?: number): Promise<Response> {
    const headers = new Headers();
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (this.apiKey) headers.set("X-API-Key", this.apiKey);
    if (ifMatchVersion !== undefined) headers.set("If-Match", `"v${ifMatchVersion}"`);
    const response = await this.fetchWithTimeout(this.baseUrl + path, {
      method,
      headers,
      credentials: this.credentials,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) {
      const payload = await readErrorPayload(response);
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
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Atlas request timed out after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
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
  const errorCode = "error_code" in payload && typeof payload.error_code === "string" ? payload.error_code : undefined;
  const message = "message" in payload && typeof payload.message === "string" ? payload.message : undefined;
  return {
    ...(errorCode === undefined ? {} : { error_code: errorCode }),
    ...(message === undefined ? {} : { message })
  };
}
