import { sanitizeErrorMessage } from "@the-drunken-coder/atlas-sdk/errors";

const SAFE_FALLBACK = "Atlas Core returned an unsafe error message.";

export function sanitizeConnectionError(cause: unknown): string {
  return sanitizeErrorMessage(cause, { fallback: SAFE_FALLBACK });
}
