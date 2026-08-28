import type { JSONValue } from "./protocol.js";

const SAFE_FALLBACK = "An unsafe error message was removed.";
const QUOTED_PARAMETER = /([?&#;])([^=&#;\s]+)=((?:(["'])(?:\\.|(?!\4)[^\\])*\4))/gi;
const SENSITIVE_PARAMETER =
  /([?&#;])([^=&#;\s]+)=((?:(["'])(?:\\.|(?!\4)[^\\?])*\4)|(?:(?![?&#]|;\s*(?:\{|[^=&#;\s]+=))[^?&#])*)/gi;
const FULL_PARAMETER =
  /([?&#;])([^=&#;\s]+)=((?:(["'])(?:\\.|(?!\4)[^\\])*\4)|(?:(?![&#]|;\s*(?:\{|[^=&#;\s]+=))[^&#\s])*)/gi;
const SENSITIVE_NAME_PATTERN =
  "(?:atlas[ _-]?session|oauth[ _-]?(?:code|token)|saml[ _-]?assertion|x[ _-]?amz[ _-]?credential|database[ _-]?password|user[ _-]?access[ _-]?token|aws[ _-]?(?:access[ _-]?key(?:[ _-]?id)?|secret[ _-]?access[ _-]?key(?:[ _-]?id)?)|access[ _-]?key(?:[ _-]?id)?|secret[ _-]?access[ _-]?key(?:[ _-]?id)?|private[ _-]?key|access[ _-]?token|api[ _-]?key|authorization|auth[ _-]?token|bearer(?:[ _-]?token)?|client[ _-]?(?:secret(?:[ _-]?value)?|token)|cookie|credential(?:s)?|csrf[ _-]?token|db[ _-]?password|id[ _-]?token|j[ _-]?session[ _-]?id(?![A-Za-z0-9])|key|password[ _-]?hash|password|refresh[ _-]?token|secret|session(?:[ _-]?(?:id|token))?(?![A-Za-z0-9])|signature|token|x[ _-]?api[ _-]?key(?![A-Za-z0-9])|x[ _-]?amz[ _-]?signature)";
const SENSITIVE_PARAMETER_NAME = new RegExp(`(?:^|[._-]|\\[)${SENSITIVE_NAME_PATTERN}`, "i");
const CAMEL_SENSITIVE_PARAMETER_NAME = new RegExp(`(?:^|[._-]|\\[)${SENSITIVE_NAME_PATTERN}(?:\\]|$)`, "i");
const SENSITIVE_WIRE_PARAMETER_NAME = /^(?:code|samlresponse)$/i;
const PREFIXED_COMPOUND_SENSITIVE_NAME =
  /(?:api[ _-]?key|access[ _-]?token|authorization|password(?:[ _-]?hash)?|secret|token)(?:\]|$)/i;
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
const COMPLETE_HEADER_VALUE = new RegExp(
  String.raw`^(?:${AMBIGUOUS_NESTED_COLLECTION}|${BRACKETED_COLLECTION}|\\?(["'])(?:\\.|(?!\1)[^\\])*\\?\1|[^\n\r}]+)`
);
const AUTHORIZATION_NAME = /authorization(?:\]|$)/i;
const COOKIE_FIELD = new RegExp(
  String.raw`((?:\\?["']?\b(?:[A-Za-z0-9]+[._-])*(?:set[_-]?)?cookie\b(?:\[[^\]]*\])*\\?["']?)\s*[:=]\s*)(?:${AMBIGUOUS_NESTED_COLLECTION}|${BRACKETED_COLLECTION}|\\?(["'])(?:\\.|(?!\2)[^\\])*\\?\2|[^\n\r}]+)`,
  "gi"
);
const URL_USERINFO = /((?:[a-z][a-z\d+\-.]*:)?(?:\/\/|(?:\\+\/){2}))[^/\s:@]*(?::[^/\s]*)?@(?=[^/\s]+(?:[/?#\s]|$))/gi;
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/gi;
const BASIC_TOKEN = /\bBasic\s+[^\s,;]+/gi;
const KNOWN_SECRET = /\batlas_ak_[A-Za-z0-9._-]+\b/g;
const TERMINAL_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const SENSITIVE_HINT =
  /[%\\@]|bearer|basic|atlas_ak_|password|secret|token|key|credential|cookie|session|auth|code|saml|signature/i;

export type ErrorMessageSanitizerOptions = {
  fallback?: string;
  maxLength?: number;
};

function redactParameter(match: string, prefix: string, name: string): string {
  return isSensitiveName(name, true) ? `${prefix}${name}=[redacted]` : match;
}

function isSensitiveName(name: string, includeWireAliases = false): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return true;
  }
  if (includeWireAliases && SENSITIVE_WIRE_PARAMETER_NAME.test(decoded)) return true;
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
    const value = (isAuthorizationName(field[1]) ? COMPLETE_HEADER_VALUE : STRUCTURED_VALUE).exec(
      message.slice(valueStart)
    )?.[0];
    if (!value) continue;
    sanitized += `${message.slice(cursor, valueStart)}[redacted]`;
    cursor = valueStart + value.length;
    STRUCTURED_FIELD_PREFIX.lastIndex = cursor;
  }
  return `${sanitized}${message.slice(cursor)}`;
}

function isAuthorizationName(name: string): boolean {
  try {
    const decoded = decodeURIComponent(name.replace(/\+/g, " "));
    return AUTHORIZATION_NAME.test(decoded.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
  } catch {
    return true;
  }
}

function redactMessage(message: string): string {
  const withoutControls = message.replace(TERMINAL_CONTROL, "");
  if (!SENSITIVE_HINT.test(withoutControls)) return withoutControls;
  const redacted = withoutControls
    .replace(URL_USERINFO, "$1[redacted]@")
    .replace(QUOTED_PARAMETER, redactParameter)
    .replace(SENSITIVE_PARAMETER, redactParameter)
    .replace(FULL_PARAMETER, redactParameter)
    .replace(COOKIE_FIELD, "$1[redacted]");
  return redactStructuredFields(redacted)
    .replace(SENSITIVE_FIELD, "$1[redacted]")
    .replace(BEARER_TOKEN, "Bearer [redacted]")
    .replace(BASIC_TOKEN, "Basic [redacted]")
    .replace(KNOWN_SECRET, "[redacted]");
}

export function sanitizeErrorMessage(cause: unknown, options: ErrorMessageSanitizerOptions = {}): string {
  const fallback = options.fallback ?? SAFE_FALLBACK;
  const maxLength = options.maxLength ?? 240;
  let message: unknown = "";
  try {
    message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  } catch {
    return fallback;
  }
  if (typeof message !== "string") return fallback;
  const inputLimit = Math.max(2_000, maxLength);
  const prefix = message.slice(0, inputLimit + 1);
  const lineEnd = prefix.search(/[\n\r\u2028\u2029]/u);
  if (lineEnd < 0 && message.length > inputLimit) return fallback;
  const firstLine = (lineEnd < 0 ? prefix : prefix.slice(0, lineEnd)).trim();
  if (!firstLine || firstLine.length > inputLimit || /^[\[{<]/u.test(firstLine)) return fallback;

  const sanitized = redactMessage(firstLine);
  if (!SENSITIVE_HINT.test(firstLine)) return truncateMessage(sanitized, maxLength);
  let normalized = sanitized;
  let settled = false;
  for (let pass = 0; pass < 2; pass++) {
    let next: string;
    try {
      next = decodeURIComponent(normalized.replace(/%(?![0-9a-f]{2})/gi, "%25"))
        .replace(/\\+u\{([0-9a-f]{1,6})\}/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/\\+u([0-9a-f]{4})/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
        .replace(/\\+x([0-9a-f]{2})/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
    } catch {
      return fallback;
    }
    if (next === normalized) {
      settled = true;
      break;
    }
    normalized = next;
    if (redactMessage(normalized) !== normalized) return fallback;
  }
  if (!settled) return fallback;
  return truncateMessage(sanitized, maxLength);
}

export function sanitizeErrorDetails(value: unknown): JSONValue | undefined {
  return sanitizeDetailValue(value, 0, { remaining: 10_000 });
}

function sanitizeDetailValue(value: unknown, depth: number, budget: { remaining: number }): JSONValue | undefined {
  if (depth > 32 || budget.remaining-- <= 0) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    return sanitizeErrorMessage(value, { fallback: "[redacted]", maxLength: 4096 });
  }
  if (Array.isArray(value)) {
    const result: JSONValue[] = [];
    for (const item of value) {
      const sanitized = sanitizeDetailValue(item, depth + 1, budget);
      if (sanitized === undefined) return undefined;
      result.push(sanitized);
    }
    return result;
  }
  if (typeof value !== "object") return undefined;
  const result: Record<string, JSONValue> = Object.create(null) as Record<string, JSONValue>;
  try {
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveName(key)) {
        result[key] = "[redacted]";
        continue;
      }
      const sanitized = sanitizeDetailValue(item, depth + 1, budget);
      if (sanitized === undefined) return undefined;
      result[key] = sanitized;
    }
  } catch {
    return undefined;
  }
  return result;
}

function truncateMessage(message: string, maxLength: number): string {
  return message.length > maxLength ? `${message.slice(0, Math.max(0, maxLength - 1))}…` : message;
}
