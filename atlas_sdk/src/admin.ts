import { HttpTransport } from "./http.js";
import type { FetchLike } from "./types.js";

export type AtlasAdminClientOptions = {
  baseUrl: string;
  credentials?: RequestCredentials;
  fetch?: FetchLike;
  requestTimeoutMs?: number;
};

export type AdminUser = {
  username: string;
  role: "admin" | "operator" | string;
  expires_at?: string;
};

export type AdminMeResponse = {
  user: AdminUser;
};

export type AdminLoginRequest = {
  username: string;
  password: string;
};

export type AdminAPIKey = {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  created_by: string;
};

export type AdminCreateAPIKeyRequest = {
  name: string;
};

export type AdminCreatedAPIKey = AdminAPIKey & {
  api_key: string;
};

export class AtlasAdminClient {
  readonly auth = {
    login: (request: AdminLoginRequest) => this.transport.json("POST", "/admin/auth/login", isAdminMeResponse, request),
    logout: () => this.transport.empty("POST", "/admin/auth/logout"),
    me: () => this.transport.json("GET", "/admin/auth/me", isAdminMeResponse)
  };

  readonly apiKeys = {
    list: () => this.transport.json("GET", "/admin/api-keys", isAdminAPIKeyList),
    create: (request: AdminCreateAPIKeyRequest) => this.transport.json("POST", "/admin/api-keys", isAdminCreatedAPIKey, request),
    revoke: (id: string) => this.transport.empty("DELETE", `/admin/api-keys/${encodeURIComponent(id)}`)
  };

  private readonly transport: HttpTransport;

  constructor(options: AtlasAdminClientOptions) {
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!fetchImpl) {
      throw new Error("AtlasAdminClient requires a fetch implementation");
    }
    this.transport = new HttpTransport({
      baseUrl: options.baseUrl,
      credentials: options.credentials,
      fetchImpl,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000
    });
  }
}

function isAdminMeResponse(value: unknown): value is AdminMeResponse {
  return (
    isRecord(value) &&
    isRecord(value.user) &&
    isNonEmptyString(value.user.username) &&
    isNonEmptyString(value.user.role) &&
    (value.user.expires_at === undefined || isNonEmptyString(value.user.expires_at))
  );
}

function isAdminAPIKeyList(value: unknown): value is AdminAPIKey[] {
  return Array.isArray(value) && value.every(isAdminAPIKey);
}

function isAdminAPIKey(value: unknown): value is AdminAPIKey {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.key_prefix) &&
    isNonEmptyString(value.created_at) &&
    isNonEmptyString(value.created_by)
  );
}

function isAdminCreatedAPIKey(value: unknown): value is AdminCreatedAPIKey {
  return isRecord(value) && isNonEmptyString(value.api_key) && isAdminAPIKey(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
