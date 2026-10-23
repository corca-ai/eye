/** Maximum signed assignment reuse; policy freshness is a separate clock. */
export const MAX_DECISION_LEASE_MS = 15 * 60_000;

/** Renew with 20% of the issued lifetime left, capped at three minutes. */
export function leaseRefreshAt(now: number, until: number): number {
  const remaining = Math.max(0, until - now);
  return until - Math.floor(Math.min(remaining, MAX_DECISION_LEASE_MS) / 5);
}
