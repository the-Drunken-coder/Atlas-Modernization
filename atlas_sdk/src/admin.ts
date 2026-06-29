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

export class AtlasAdminClient {
  readonly auth = {
    login: (request: AdminLoginRequest) => this.transport.json<AdminMeResponse>("POST", "/admin/auth/login", request),
    logout: () => this.transport.json<void>("POST", "/admin/auth/logout"),
    me: () => this.transport.json<AdminMeResponse>("GET", "/admin/auth/me")
  };

  private readonly transport: HttpTransport;

  constructor(options: AtlasAdminClientOptions) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
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
