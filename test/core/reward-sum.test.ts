import { expect, it } from 'vitest';
import { addReward, mergeReward, type RewardSum } from '../../src/core/reward-sum.js';

const sum = (values: number[]): RewardSum => {
  const state = { scale: 0, sum: 0, correction: 0 };
  for (const value of values) addReward(state, value);
  return state;
};
const valueOf = (state: RewardSum) => (state.sum + state.correction) * state.scale;

it('starts a new scale after exact cancellation instead of underflowing later finite rewards', () => {
  expect(valueOf(sum([1e308, -1e308, 1e-100]))).toBe(1e-100);
  expect(valueOf(sum([-1e308, 1e308, -1e-100]))).toBe(-1e-100);
});

it('ignores the historical scale of zero buckets when merging signed summaries', () => {
  const cancelled = sum([1e308, -1e308]), tiny = sum([1e-100]);
  const smallThenZero = { ...tiny };
  mergeReward(smallThenZero, cancelled);
  expect(valueOf(smallThenZero)).toBe(1e-100);
  const zeroThenSmall = { ...cancelled };
  mergeReward(zeroThenSmall, tiny);
  expect(valueOf(zeroThenSmall)).toBe(1e-100);
  const sequential = sum([1e308]);
  mergeReward(sequential, sum([-1e308]));
  mergeReward(sequential, tiny);
  expect(valueOf(sequential)).toBe(1e-100);
  expect(valueOf(tiny)).toBe(1e-100);
});

it('recognizes exact cancellation between the sum and its nonzero correction', () => {
  const cancelled = sum([1e308, 1e292, -1e308, -1e292]);
  expect(valueOf(cancelled)).toBe(0);
  expect(cancelled.sum).not.toBe(0);
  for (const reward of [7, 1e-100, -1e-100]) {
    const added = { ...cancelled };
    addReward(added, reward);
    expect(valueOf(added)).toBe(reward);
    const merged = { ...cancelled };
    mergeReward(merged, sum([reward]));
    expect(valueOf(merged)).toBe(reward);
    const reversed = sum([reward]);
    mergeReward(reversed, cancelled);
    expect(valueOf(reversed)).toBe(reward);
  }
});
