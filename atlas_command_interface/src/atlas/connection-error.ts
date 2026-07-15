const SAFE_FALLBACK = "Atlas Core returned an unsafe error message.";
const SENSITIVE_PARAMETER = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|token)[^=]*=)[^&#\s]*/gi;
const SENSITIVE_FIELD =
  /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|client[_-]?secret|cookie|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^;\n\r}]+)/gi;
const URL_USERINFO = /((?:https?|wss?):\/\/)[^/\s:@]+(?::[^@\s]*)?@/gi;
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/gi;
const KNOWN_SECRET = /\batlas_ak_[A-Za-z0-9._-]+\b/g;

export function sanitizeConnectionError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const firstLine = message.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  if (!firstLine || /^[\[{<]/u.test(firstLine)) return SAFE_FALLBACK;

  const sanitized = firstLine
    .replace(URL_USERINFO, "$1[redacted]@")
    .replace(SENSITIVE_PARAMETER, "$1[redacted]")
    .replace(SENSITIVE_FIELD, "$1[redacted]")
    .replace(BEARER_TOKEN, "Bearer [redacted]")
    .replace(KNOWN_SECRET, "[redacted]");
  return sanitized.length > 240 ? `${sanitized.slice(0, 239)}…` : sanitized;
}
