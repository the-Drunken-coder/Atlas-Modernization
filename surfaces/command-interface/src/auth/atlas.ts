import { AtlasClient, type AtlasClientOptions } from "@the-drunken-coder/atlas-sdk";
import { AtlasAdminClient, type AtlasAdminClientOptions } from "@the-drunken-coder/atlas-sdk/admin";

export const ATLAS_AUTH_EXPIRED_EVENT = "atlas-auth-expired";

/**
 * An identity for one authenticated browser session. The generation is
 * captured by clients so a response from an older client cannot expire a
 * later login.
 */
export type AuthSessionToken = number;

export type AtlasAuthExpiredEventDetail = Readonly<{ session: AuthSessionToken }>;

type AtlasClientFactoryOptions = Omit<AtlasClientOptions, "baseUrl" | "credentials" | "fetch">;
type AtlasAdminClientFactoryOptions = Omit<AtlasAdminClientOptions, "baseUrl" | "credentials" | "fetch">;

let currentSession: AuthSessionToken = 0;

/** Advance the identity whenever the browser crosses an authentication boundary. */
export function rotateAuthSession(): AuthSessionToken {
  return ++currentSession;
}

/**
 * Invalidate the supplied session only when it is still current. This makes
 * expiry events from an old in-flight request harmless after a new login.
 */
export function expireAuthSession(session: AuthSessionToken): boolean {
  if (session !== currentSession) return false;
  currentSession += 1;
  return true;
}

export function createAuthenticatedAtlasClient(baseUrl: string, options: AtlasClientFactoryOptions = {}): AtlasClient {
  return new AtlasClient({
    ...options,
    baseUrl,
    credentials: "include",
    fetch: createAtlasFetch(currentSession)
  });
}

export function createAuthenticatedAtlasAdminClient(
  baseUrl: string,
  options: AtlasAdminClientFactoryOptions = {}
): AtlasAdminClient {
  return new AtlasAdminClient({
    ...options,
    baseUrl,
    credentials: "include",
    fetch: createAtlasFetch(currentSession)
  });
}

/** Session-check and login requests use Core credentials but are not expiry signals. */
export function createUnauthenticatedAtlasAdminClient(
  baseUrl: string,
  options: AtlasAdminClientFactoryOptions = {}
): AtlasAdminClient {
  return new AtlasAdminClient({
    ...options,
    baseUrl,
    credentials: "include"
  });
}

function createAtlasFetch(session: AuthSessionToken): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, { ...init, credentials: "include" });
    if (response.status === 401 && session === currentSession) {
      const payload = (await response
        .clone()
        .json()
        .catch(() => undefined)) as { error_code?: unknown } | undefined;
      if (payload?.error_code === "UNAUTHORIZED" && session === currentSession) {
        window.dispatchEvent(
          new CustomEvent<AtlasAuthExpiredEventDetail>(ATLAS_AUTH_EXPIRED_EVENT, { detail: { session } })
        );
      }
    }
    return response;
  };
}
