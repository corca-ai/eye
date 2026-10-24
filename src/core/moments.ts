import { finite, invariant } from './errors.js';

/** Weighted central moments in units of `scale`; never squares a raw reward. */
export interface Moments {
  weight: number;
  scale: number;
  mean: number;
  m2: number;
  asOf: number;
}
export const emptyMoments = (asOf: number): Moments => ({ weight: 0, scale: 1, mean: 0, m2: 0, asOf });

export function decayFactor(elapsed: number, halfLife: number): number {
  invariant(Number.isFinite(elapsed) && elapsed >= 0 && Number.isFinite(halfLife) && halfLife > 0, 'invalid_input', 'Decay requires nonnegative elapsed time and a positive finite half-life');
  return 2 ** (-elapsed / halfLife);
}
export function ageMoments(m: Readonly<Moments>, now: number, halfLife: number): Moments {
  const factor = decayFactor(now - m.asOf, halfLife);
  if (m.weight * factor === 0) return emptyMoments(now);
  return { ...m, weight: m.weight * factor, m2: m.m2 * factor, asOf: now };
}

export function addSample(m: Readonly<Moments>, value: number, weight = 1): Moments {
  finite(value, 'Reward');
  invariant(Number.isFinite(weight) && weight >= 0, 'invalid_input', 'Sample weight must be nonnegative and finite');
  if (weight === 0) return { ...m };
  const allZero = m.mean === 0 && m.m2 === 0;
  const scale = allZero ? (Math.abs(value) || 1) : Math.max(m.scale, Math.abs(value));
  const ratio = m.scale / scale;
  const oldMean = allZero ? 0 : m.mean * ratio;
  const y = value / scale;
  const total = finite(m.weight + weight, 'Total weight');
  const delta = y - oldMean;
  const mean = oldMean + delta * (weight / total);
  const m2 = (allZero ? 0 : m.m2 * ratio * ratio) + delta * delta * (m.weight / total) * weight;
  return { weight: total, scale, mean, m2: finite(m2, 'Central moment'), asOf: m.asOf };
}

export function mergeMoments(a: Readonly<Moments>, b: Readonly<Moments>): Moments {
  invariant(a.asOf === b.asOf, 'invalid_input', 'Merge moments at the same time');
  if (b.weight === 0) return { ...a };
  if (a.weight === 0) return { ...b };
  const aZero = a.mean === 0 && a.m2 === 0;
  const bZero = b.mean === 0 && b.m2 === 0;
  const scale = Math.max(aZero ? 0 : a.scale, bZero ? 0 : b.scale) || 1;
  const ra = aZero ? 0 : a.scale / scale, rb = bZero ? 0 : b.scale / scale;
  const meanA = a.mean * ra, meanB = b.mean * rb;
  const weight = finite(a.weight + b.weight, 'Total weight');
  const delta = meanB - meanA;
  return {
    weight, scale, asOf: a.asOf,
    mean: meanA + delta * (b.weight / weight),
    m2: finite(a.m2 * ra * ra + b.m2 * rb * rb + delta * delta * (a.weight / weight) * b.weight, 'Central moment'),
  };
}
export function meanOf(m: Readonly<Moments>): number { return m.weight === 0 ? 0 : finite(m.mean * m.scale, 'Mean'); }
export function stddevOf(m: Readonly<Moments>): number {
  return m.weight === 0 ? 0 : finite(Math.sqrt(Math.max(0, m.m2 / m.weight)) * m.scale, 'Standard deviation');
}
