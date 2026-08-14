// Small, dependency-free formatting helpers shared across inspector panels.

export function formatRelativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "—";
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 0) return "in the future";
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatNumber(value: number | undefined, options: { unit?: string; digits?: number } = {}): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const rounded = options.digits === undefined ? value : Number(value.toFixed(options.digits));
  return options.unit ? `${rounded} ${options.unit}` : `${rounded}`;
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}%`;
}
