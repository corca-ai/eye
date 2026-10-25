/** Anonymous exposures inside a known authenticated interval have ambiguous
 * ownership. Inputs are SQL expressions from the internal query builders. */
export function anonymousExposureSQL(uid: string, previousKind: string): string {
  return `${uid} IS NULL AND COALESCE(${previousKind}, 'logout') = 'logout'`;
}
