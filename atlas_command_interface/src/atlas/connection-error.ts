const SAFE_FALLBACK = "Atlas Core returned an unsafe error message.";
const SENSITIVE_PARAMETER = /([?&])([^=&#\s]+)=([^&#\s]*)/gi;
const SENSITIVE_NAME_PATTERN =
  "(?:access[_-]?token|api[_-]?key|auth[_-]?token|client[_-]?(?:secret|token)|cookie|csrf[_-]?token|db[_-]?password|id[_-]?token|key|password|refresh[_-]?token|secret|session[_-]?token|signature|token|x[_-]?amz[_-]?signature)";
const SENSITIVE_PARAMETER_NAME = new RegExp(`^${SENSITIVE_NAME_PATTERN}`, "i");
const SENSITIVE_FIELD = new RegExp(
  String.raw`((?:\\?["']?\b${SENSITIVE_NAME_PATTERN}\b\\?["']?)\s*[:=]\s*)(?:\\?(["'])(?:\\.|(?!\2)[^\\])*\\?\2|[^,;\n\r}]+)`,
  "gi"
);
const URL_USERINFO = /((?:[a-z][a-z\d+\-.]*:)?(?:\/\/|\\\/\\\/))[^/\s:@]+(?::[^@\s]*)?@/gi;
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/gi;
const KNOWN_SECRET = /\batlas_ak_[A-Za-z0-9._-]+\b/g;

export function sanitizeConnectionError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const firstLine = message.split(/\r?\n/u, 1)[0]?.trim().slice(0, 2_000) ?? "";
  if (!firstLine || /^[\[{<]/u.test(firstLine)) return SAFE_FALLBACK;

  const sanitized = firstLine
    .replace(URL_USERINFO, "$1[redacted]@")
    .replace(SENSITIVE_PARAMETER, (match, prefix: string, name: string) => {
      let decodedName: string;
      try {
        decodedName = decodeURIComponent(name);
      } catch {
        return `${prefix}${name}=[redacted]`;
      }
      return SENSITIVE_PARAMETER_NAME.test(decodedName) ? `${prefix}${name}=[redacted]` : match;
    })
    .replace(SENSITIVE_FIELD, "$1[redacted]")
    .replace(BEARER_TOKEN, "Bearer [redacted]")
    .replace(KNOWN_SECRET, "[redacted]");
  return sanitized.length > 240 ? `${sanitized.slice(0, 239)}…` : sanitized;
}
