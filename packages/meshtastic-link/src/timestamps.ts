// Offset the right instant by whole milliseconds without discarding fractional precision.
export function compareRFC3339Timestamps(left: string, right: string, rightOffsetMilliseconds = 0): number {
  const leftMilliseconds = Date.parse(left);
  const rightMilliseconds = Date.parse(right) + rightOffsetMilliseconds;
  if (leftMilliseconds !== rightMilliseconds) return leftMilliseconds < rightMilliseconds ? -1 : 1;

  const leftFraction = left.match(/\.(\d+)(?=(?:Z|[+-]\d{2}:\d{2})$)/)?.[1]?.slice(3) ?? "";
  const rightFraction = right.match(/\.(\d+)(?=(?:Z|[+-]\d{2}:\d{2})$)/)?.[1]?.slice(3) ?? "";
  const precision = Math.max(leftFraction.length, rightFraction.length);
  const paddedLeft = leftFraction.padEnd(precision, "0");
  const paddedRight = rightFraction.padEnd(precision, "0");
  return paddedLeft < paddedRight ? -1 : paddedLeft > paddedRight ? 1 : 0;
}
