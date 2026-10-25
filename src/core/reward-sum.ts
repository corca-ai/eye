/** Scaled compensated sum for finite signed rewards, including cancelling large values. */
export type RewardSum = { scale: number; sum: number; correction: number };
export function addReward(total: RewardSum, value: number): void {
  if (value === 0) return;
  // Exact cancellation leaves no evidence requiring the old scale. Keeping it
  // would underflow later small rewards even though the current sum is zero.
  if (total.sum === -total.correction) {
    total.scale = Math.abs(value); total.sum = Math.sign(value); total.correction = 0; return;
  }
  const scale = Math.max(total.scale, Math.abs(value));
  const ratio = total.scale / scale;
  const previous = total.sum * ratio, term = value / scale;
  const next = previous + term;
  total.correction = total.correction * ratio + (Math.abs(previous) >= Math.abs(term)
    ? (previous - next) + term : (term - next) + previous);
  total.sum = next;
  total.scale = scale;
}

/** Merge all compensated components at a shared scale; never materialize bucket totals. */
export function mergeReward(total: RewardSum, other: RewardSum): void {
  if (other.sum === -other.correction) return;
  if (total.sum === -total.correction) {
    total.scale = other.scale; total.sum = other.sum; total.correction = other.correction; return;
  }
  const scale = Math.max(total.scale, other.scale);
  if (scale === 0) return;
  const a = total.scale / scale, b = other.scale / scale;
  const terms = [total.sum * a, total.correction * a, other.sum * b, other.correction * b];
  let sum = 0, correction = 0;
  for (const term of terms) {
    const next = sum + term;
    correction += Math.abs(sum) >= Math.abs(term) ? (sum - next) + term : (term - next) + sum;
    sum = next;
  }
  total.scale = scale; total.sum = sum; total.correction = correction;
}
