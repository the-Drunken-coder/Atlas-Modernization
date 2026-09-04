/**
 * Reports whether a parsed URL hostname identifies the local machine.
 * IPv4-mapped IPv6 values are normalized through the WHATWG URL parser so
 * textual and canonical forms share the same 127/8 check.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIPv4Loopback(normalized)) return true;

  const canonical = canonicalIPv6Hostname(normalized);
  return canonical !== undefined && isIPv4MappedLoopback(canonical);
}

function canonicalIPv6Hostname(hostname: string): string | undefined {
  if (!hostname.includes(":")) return undefined;
  try {
    return new URL(`http://[${hostname}]`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function isIPv4Loopback(hostname: string): boolean {
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255);
}

function isIPv4MappedLoopback(hostname: string): boolean {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hostname);
  if (!match) return false;
  return Number.parseInt(match[1]!, 16) >>> 8 === 0x7f;
}
