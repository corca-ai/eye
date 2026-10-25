import { createEye, type EyeOptions } from '@eye/workers';

const HOUR = 3_600_000;
/** Call only after authorizing the operator for this site and the purchase goal.
 * Enable summaries once through a trusted admin route, not on every page load:
 * eye.analytics.summaries.configure({ goalIds: ['purchase'], experimentIds: [] })
 */
export async function purchaseDashboard(options: EyeOptions) {
  const eye = createEye(options), status = await eye.analytics.summaries.status();
  const to = Math.floor(Date.now() / HOUR) * HOUR, from = to - 24 * HOUR;
  if (status.state !== 'collecting' || status.coverageFrom === null || from < status.coverageFrom) {
    return { state: 'unavailable' as const, summaryState: status.state, coverageFrom: status.coverageFrom };
  }
  // No raw-query fallback: missing coverage is not a zero total. A configuration
  // change between status and query can still reject; the host handles that error.
  const report = await eye.analytics.summaries.query({ kind: 'goals', goalId: 'purchase', from, to });
  return { state: 'ready' as const, report }; // Display basis, range and queriedAt.
}

/** Register once after the full 24-hour range is covered. scope is server supplied. */
export async function schedulePurchaseReport(options: EyeOptions) {
  return createEye(options).analytics.jobs.schedule({
    scope: 'analytics-staff-v1', scheduleId: 'purchase-summary',
    report: { kind: 'summary', target: { kind: 'goals', goalId: 'purchase' } },
    windowMs: 24 * HOUR, intervalMs: HOUR,
  });
}
