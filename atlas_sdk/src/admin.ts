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
    login: (request: AdminLoginRequest) => this.transport.json<AdminMeResponse>("POST", "/admin/auth/login", request),
    logout: () => this.transport.json<void>("POST", "/admin/auth/logout"),
    me: () => this.transport.json<AdminMeResponse>("GET", "/admin/auth/me")
  };

  readonly apiKeys = {
    list: () => this.transport.json<AdminAPIKey[]>("GET", "/admin/api-keys"),
    create: (request: AdminCreateAPIKeyRequest) => this.transport.json<AdminCreatedAPIKey>("POST", "/admin/api-keys", request),
    revoke: (id: string) => this.transport.json<void>("DELETE", `/admin/api-keys/${encodeURIComponent(id)}`)
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
