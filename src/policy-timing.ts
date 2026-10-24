/** Request cache validation, hard publication expiry, and score aging are separate. */
export const DEFAULT_POLICY_FRESH_MS = 15 * 60_000;
export const DEFAULT_POLICY_MAX_AGE_MS = 6 * 3_600_000;
export const POLICY_REEVALUATION_MS = 3_600_000;
/** Keep omitted freshness usable with an explicitly shorter maximum age, leaving
 * time for background refresh before hard expiry whenever the interval allows. */
export function policyFreshMs(options?: { freshMs?: number; maxAgeMs?: number }): number {
  return options?.freshMs ?? Math.min(DEFAULT_POLICY_FRESH_MS, Math.max(1, Math.floor((options?.maxAgeMs ?? DEFAULT_POLICY_MAX_AGE_MS) / 2)));
}
