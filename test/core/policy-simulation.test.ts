import { afterAll, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { scenarios, simulatePolicy } from '../helpers/policy-simulation.js';

const report: Record<string, unknown> = {};
const mean = (numbers: number[]) => numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
it.each(scenarios)('compares %s against the frozen allocation over 32 paired seeds', scenario => {
  const runs = Array.from({ length: 32 }, (_, i) => ({ seed: i + 1,
    current: simulatePolicy(scenario, i + 1, false), baseline: simulatePolicy(scenario, i + 1, true) }));
  const summarize = (key: 'current' | 'baseline') => ({
    expectedFraction: mean(runs.map(r => r[key].expectedFraction)),
    realizedFraction: mean(runs.map(r => r[key].realizedFraction)),
    lateBestShare: mean(runs.map(r => r[key].lateBestShare)),
  });
  const current = summarize('current'), baseline = summarize('baseline');
  // Predeclared engineering gates: improve both demonstrated pathologies, keep
  // expected reward within 10% of oracle versus baseline on adverse scenarios.
  expect(current.expectedFraction).toBeGreaterThan(baseline.expectedFraction - .1);
  if (scenario === 'sparse' || scenario === 'poor-newcomer')
    expect(current.expectedFraction).toBeGreaterThan(baseline.expectedFraction + .05);
  if (scenario !== 'jackpot') expect(current.lateBestShare).toBeGreaterThan(.65);
  report[scenario] = { current, baseline, runs };
});
afterAll(() => {
  if (process.env.EYE_POLICY_REPORT && Object.keys(report).length === scenarios.length) writeFileSync(process.env.EYE_POLICY_REPORT, JSON.stringify(report, null, 2) + '\n');
});
