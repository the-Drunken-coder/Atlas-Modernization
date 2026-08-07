export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function isTimerDelayInRange(value: number, allowZero = false): boolean {
  return Number.isFinite(value) && value <= MAX_TIMER_DELAY_MS && (allowZero ? value >= 0 : value > 0);
}
