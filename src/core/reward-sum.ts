/** Scaled compensated sum for finite signed rewards, including cancelling large values. */
export type RewardSum = { scale: number; sum: number; correction: number };
export function addReward(total: RewardSum, value: number): void {
  if (value === 0) return;
  const scale = Math.max(total.scale, Math.abs(value));
  const ratio = total.scale / scale;
  const previous = total.sum * ratio, term = value / scale;
  const next = previous + term;
  total.correction = total.correction * ratio + (Math.abs(previous) >= Math.abs(term)
    ? (previous - next) + term : (term - next) + previous);
  total.sum = next;
  total.scale = scale;
}
