/** Normalize a caller-supplied Atlas resource identifier at the SDK boundary. */
export function normalizeResourceID(name: string, value: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must not be empty`);
  return normalized;
}
