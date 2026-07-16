const SAFE_FALLBACK = "Atlas Core returned an unsafe error message.";
const QUOTED_PARAMETER = /([?&#;])([^=&#;\s]+)=((?:(["'])(?:\\.|(?!\4)[^\\])*\4))/gi;
const SENSITIVE_PARAMETER = /([?&#;])([^=&#;\s]+)=((?:(["'])(?:\\.|(?!\4)[^\\?])*\4)|(?:(?![?&#]|;\s*(?:\{|[^=&#;\s]+=))[^?&#])*)/gi;
const FULL_PARAMETER = /([?&#;])([^=&#;\s]+)=((?:(["'])(?:\\.|(?!\4)[^\\])*\4)|(?:(?![&#]|;\s*(?:\{|[^=&#;\s]+=))[^&#\s])*)/gi;
const SENSITIVE_NAME_PATTERN =
  "(?:atlas[ _-]?session|oauth[ _-]?token|x[ _-]?amz[ _-]?credential|database[ _-]?password|user[ _-]?access[ _-]?token|aws[ _-]?(?:access[ _-]?key(?:[ _-]?id)?|secret[ _-]?access[ _-]?key(?:[ _-]?id)?)|access[ _-]?key(?:[ _-]?id)?|secret[ _-]?access[ _-]?key(?:[ _-]?id)?|private[ _-]?key|access[ _-]?token|api[ _-]?key|authorization|auth[ _-]?token|bearer(?:[ _-]?token)?|client[ _-]?(?:secret(?:[ _-]?value)?|token)|cookie|credential(?:s)?|csrf[ _-]?token|db[ _-]?password|id[ _-]?token|j[ _-]?session[ _-]?id(?![A-Za-z0-9])|key|password[ _-]?hash|password|refresh[ _-]?token|secret|session(?:[ _-]?(?:id|token))?(?![A-Za-z0-9])|signature|token|x[ _-]?api[ _-]?key(?![A-Za-z0-9])|x[ _-]?amz[ _-]?signature)";
const SENSITIVE_PARAMETER_NAME = new RegExp(`(?:^|[._-]|\\[)${SENSITIVE_NAME_PATTERN}`, "i");
const CAMEL_SENSITIVE_PARAMETER_NAME = new RegExp(`(?:^|[._-]|\\[)${SENSITIVE_NAME_PATTERN}(?:\\]|$)`, "i");
const PREFIXED_COMPOUND_SENSITIVE_NAME = /(?:api[ _-]?key|access[ _-]?token|authorization)(?:\]|$)/i;
const BRACKETED_COLLECTION_CONTENT = String.raw`(?:\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\\\[\]"'\n\r])*`;
const AMBIGUOUS_NESTED_COLLECTION = String.raw`\[(?=${BRACKETED_COLLECTION_CONTENT}\[)[^\n\r]*`;
const BRACKETED_COLLECTION = String.raw`\[${BRACKETED_COLLECTION_CONTENT}\]`;
const AMBIGUOUS_OBJECT_VALUE = String.raw`\{[^\n\r]*`;
const AMBIGUOUS_SEMICOLON_VALUE = String.raw`[^\n\r}]*;[^\n\r}]*`;
const SENSITIVE_FIELD = new RegExp(
  String.raw`((?:\\?["']?\b(?:[A-Za-z0-9]+(?:[._-]|\[))*${SENSITIVE_NAME_PATTERN}(?:[._-][A-Za-z0-9]+)*\b(?:\[[^\]]*\])*\]?\\?["']?)\s*[:=]\s*)(?:${AMBIGUOUS_NESTED_COLLECTION}|${BRACKETED_COLLECTION}|${AMBIGUOUS_OBJECT_VALUE}|${AMBIGUOUS_SEMICOLON_VALUE}|\\?(["'])(?:\\.|(?!\2)[^\\])*\\?\2|[^,;\n\r}]+(?:,(?!\s*["']?[A-Za-z0-9_.-]+["']?\s*[:=])\s*[^,;\n\r}]+)*)`,
  "gi"
);
const STRUCTURED_FIELD_PREFIX = /(?:\\?["']?)([A-Za-z0-9_.%+\[\]-]+)\\?["']?\s*[:=]\s*/g;
const STRUCTURED_VALUE = new RegExp(
  String.raw`^(?:${AMBIGUOUS_NESTED_COLLECTION}|${BRACKETED_COLLECTION}|${AMBIGUOUS_OBJECT_VALUE}|${AMBIGUOUS_SEMICOLON_VALUE}|\\?(["'])(?:\\.|(?!\1)[^\\])*\\?\1|[^,;\n\r}]+(?:,(?!\s*["']?[A-Za-z0-9_.-]+["']?\s*[:=])\s*[^,;\n\r}]+)*)`
);
const COOKIE_FIELD = new RegExp(
  String.raw`((?:\\?["']?\b(?:[A-Za-z0-9]+[._-])*(?:set[_-]?)?cookie\b(?:\[[^\]]*\])*\\?["']?)\s*[:=]\s*)(?:${AMBIGUOUS_NESTED_COLLECTION}|${BRACKETED_COLLECTION}|\\?(["'])(?:\\.|(?!\2)[^\\])*\\?\2|[^\n\r}]+)`,
  "gi"
);
const URL_USERINFO = /((?:[a-z][a-z\d+\-.]*:)?(?:\/\/|(?:\\+\/){2}))[^/\s:@]*(?::[^/\s]*)?@(?=[^/\s]+(?:[/?#\s]|$))/gi;
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/gi;
const KNOWN_SECRET = /\batlas_ak_[A-Za-z0-9._-]+\b/g;

function redactParameter(match: string, prefix: string, name: string): string {
  return isSensitiveName(name) ? `${prefix}${name}=[redacted]` : match;
}

function isSensitiveName(name: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return true;
  }
  if (SENSITIVE_PARAMETER_NAME.test(decoded)) return true;
  if (PREFIXED_COMPOUND_SENSITIVE_NAME.test(decoded)) return true;
  const normalized = decoded.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return normalized !== decoded && CAMEL_SENSITIVE_PARAMETER_NAME.test(normalized);
}

function redactStructuredFields(message: string): string {
  let cursor = 0;
  let sanitized = "";
  STRUCTURED_FIELD_PREFIX.lastIndex = 0;
  for (let field = STRUCTURED_FIELD_PREFIX.exec(message); field; field = STRUCTURED_FIELD_PREFIX.exec(message)) {
    if (!isSensitiveName(field[1])) continue;
    const valueStart = STRUCTURED_FIELD_PREFIX.lastIndex;
    const value = STRUCTURED_VALUE.exec(message.slice(valueStart))?.[0];
    if (!value) continue;
    sanitized += `${message.slice(cursor, valueStart)}[redacted]`;
    cursor = valueStart + value.length;
    STRUCTURED_FIELD_PREFIX.lastIndex = cursor;
  }
  return `${sanitized}${message.slice(cursor)}`;
}

function redactConnectionMessage(message: string): string {
  const redacted = message
    .replace(URL_USERINFO, "$1[redacted]@")
    .replace(QUOTED_PARAMETER, redactParameter)
    .replace(SENSITIVE_PARAMETER, redactParameter)
    .replace(FULL_PARAMETER, redactParameter)
    .replace(COOKIE_FIELD, "$1[redacted]");
  return redactStructuredFields(redacted)
    .replace(SENSITIVE_FIELD, "$1[redacted]")
    .replace(BEARER_TOKEN, "Bearer [redacted]")
    .replace(KNOWN_SECRET, "[redacted]");
}

export function sanitizeConnectionError(cause: unknown): string {
  let message: unknown = "";
  try {
    message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  } catch {
    return SAFE_FALLBACK;
  }
  if (typeof message !== "string") return SAFE_FALLBACK;
  const firstLine = message.split(/\r\n|[\n\r\u2028\u2029]/u, 1)[0]?.trim() ?? "";
  if (!firstLine || firstLine.length > 2_000 || /^[\[{<]/u.test(firstLine)) return SAFE_FALLBACK;

  const sanitized = redactConnectionMessage(firstLine);
  let normalized = sanitized;
  let settled = false;
  for (let pass = 0; pass < 2; pass++) {
    let next: string;
    try {
      next = decodeURIComponent(normalized.replace(/%(?![0-9a-f]{2})/gi, "%25"))
        .replace(/\\+u([0-9a-f]{4})/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
        .replace(/\\+x([0-9a-f]{2})/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
    } catch {
      return SAFE_FALLBACK;
    }
    if (next === normalized) {
      settled = true;
      break;
    }
    normalized = next;
    if (redactConnectionMessage(normalized) !== normalized) return SAFE_FALLBACK;
  }
  if (!settled) return SAFE_FALLBACK;
  return sanitized.length > 240 ? `${sanitized.slice(0, 239)}…` : sanitized;
}
