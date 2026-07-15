const SAFE_FALLBACK = "Atlas Core returned an unsafe error message.";
const SENSITIVE_PARAMETER = /([?&#;])([^=&#;\s]+)=((?:(["'])(?:\\.|(?!\4)[^\\])*\4)|[^&#;\s]*)/gi;
const SENSITIVE_NAME_PATTERN =
  "(?:aws[_-]?(?:access[_-]?key|secret[_-]?access[_-]?key)|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key(?:[_-]?id)?|private[_-]?key|access[_-]?token|api[_-]?key|authorization|auth[_-]?token|bearer[_-]?token|client[_-]?(?:secret|token)|cookie|credential(?:s)?|csrf[_-]?token|db[_-]?password|id[_-]?token|key|password|refresh[_-]?token|secret|session(?:[_-]?(?:id|token))?(?![A-Za-z0-9])|signature|token|x[_-]?amz[_-]?signature)";
const SENSITIVE_PARAMETER_NAME = new RegExp(`(?:^|[._-]|\\[)${SENSITIVE_NAME_PATTERN}`, "i");
const BRACKETED_COLLECTION = String.raw`\[(?:\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\]\n\r])*\]`;
const AMBIGUOUS_OBJECT_VALUE = String.raw`\{[^\n\r]*`;
const SENSITIVE_FIELD = new RegExp(
  String.raw`((?:\\?["']?\b(?:[A-Za-z0-9]+(?:[._-]|\[))*${SENSITIVE_NAME_PATTERN}\b(?:\[[^\]]*\])*\]?\\?["']?)\s*[:=]\s*)(?:${BRACKETED_COLLECTION}|${AMBIGUOUS_OBJECT_VALUE}|\\?(["'])(?:\\.|(?!\2)[^\\])*\\?\2|[^,;\n\r}]+(?:,(?!\s*["']?[A-Za-z0-9_.-]+["']?\s*[:=])\s*[^,;\n\r}]+)*)`,
  "gi"
);
const COOKIE_FIELD = new RegExp(
  String.raw`((?:\\?["']?\b(?:[A-Za-z0-9]+[._-])*(?:set[_-]?)?cookie\b(?:\[[^\]]*\])*\\?["']?)\s*[:=]\s*)(?:${BRACKETED_COLLECTION}|\\?(["'])(?:\\.|(?!\2)[^\\])*\\?\2|[^\n\r}]+)`,
  "gi"
);
const URL_USERINFO = /((?:[a-z][a-z\d+\-.]*:)?(?:\/\/|\\\/\\\/))[^/\s:@]*(?::[^/\s]*)?@(?=[^/\s]+(?:[/?#\s]|$))/gi;
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/gi;
const KNOWN_SECRET = /\batlas_ak_[A-Za-z0-9._-]+\b/g;

function redactConnectionMessage(message: string): string {
  return message
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
    .replace(COOKIE_FIELD, "$1[redacted]")
    .replace(SENSITIVE_FIELD, "$1[redacted]")
    .replace(BEARER_TOKEN, "Bearer [redacted]")
    .replace(KNOWN_SECRET, "[redacted]");
}

export function sanitizeConnectionError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const firstLine = message.split(/\r\n|[\n\r\u2028\u2029]/u, 1)[0]?.trim() ?? "";
  if (!firstLine || firstLine.length > 2_000 || /^[\[{<]/u.test(firstLine)) return SAFE_FALLBACK;

  const sanitized = redactConnectionMessage(firstLine);
  let decoded = sanitized;
  for (let pass = 0; pass < 2; pass++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break;
    }
    if (next === decoded) break;
    decoded = next;
    if (redactConnectionMessage(decoded) !== decoded) return SAFE_FALLBACK;
  }
  return sanitized.length > 240 ? `${sanitized.slice(0, 239)}…` : sanitized;
}
