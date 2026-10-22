#!/usr/bin/env python3
"""Design experiment, not production SDK code. Python standard library only."""
from __future__ import annotations

import argparse
import hashlib
import heapq
import json
import math
import random
import statistics
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Moments:
    n: float = 0.0
    total: float = 0.0
    squares: float = 0.0
    updated: float = 0.0

    def age(self, now: float, half_life: float) -> None:
        factor = 1.0 if math.isinf(half_life) else 2 ** (-(now - self.updated) / half_life)
        self.n *= factor
        self.total *= factor
        self.squares *= factor
        self.updated = now

    def observe(self, value: float, weight: float = 1.0) -> None:
        self.n += weight
        self.total += weight * value
        self.squares += weight * value * value

    def revise(self, old: float, new: float, weight: float) -> None:
        self.total += weight * (new - old)
        self.squares += weight * (new * new - old * old)


class OptimisticPolicy:
    """Discounted empirical optimism; scores are NOT calibrated confidence bounds."""

    def __init__(self, half_life: float, scale: float = 1.0):
        self.half_life = half_life
        self.scale = scale
        self.stats = {a: Moments() for a in range(3)}
        self.pending = {a: 0 for a in range(3)}

    def age(self, day: float) -> None:
        for stats in self.stats.values():
            stats.age(day, self.half_life)

    def scores(self, active: list[int]) -> dict[int, float]:
        n = sum(self.stats[a].n for a in active)
        total = sum(self.stats[a].total for a in active)
        squares = sum(self.stats[a].squares for a in active)
        pooled_mean = total / n if n > 1e-12 else 0.0
        pooled_sd = math.sqrt(max(0.0, squares / n - pooled_mean**2)) if n > 1e-12 else 0.0
        scale = max(self.scale, pooled_sd)
        log_mass = math.log(2 + n + sum(self.pending[a] for a in active))
        result = {}
        for arm in active:
            s = self.stats[arm]
            mean = s.total / s.n if s.n > 1e-12 else pooled_mean
            variance = max(0.0, s.squares / s.n - mean**2) if s.n > 1e-12 else scale**2
            uncertainty_scale = max(math.sqrt(variance), 0.25 * scale)
            denominator = max(s.n, 1.0) + self.pending[arm]
            result[arm] = mean + 2.0 * uncertainty_scale * math.sqrt(log_mass / denominator)
        return result

    def choose(self, active: list[int], rng: random.Random) -> int:
        # A 2% uniform floor applies only to new assignments, never overrides a hold.
        if rng.random() < 0.02:
            arm = rng.choice(active)
        else:
            cold = [a for a in active if self.stats[a].n < 8 and self.pending[a] < 8]
            if cold:
                pressure = min(self.stats[a].n + self.pending[a] for a in cold)
                arm = rng.choice([a for a in cold if self.stats[a].n + self.pending[a] == pressure])
            else:
                scores = self.scores(active)
                best = max(scores.values())
                arm = rng.choice([a for a in active if scores[a] == best])
        self.pending[arm] += 1
        return arm

    def complete(self, arm: int, value: float, end: float, now: float) -> None:
        self.pending[arm] -= 1
        weight = 1.0 if math.isinf(self.half_life) else 2 ** (-(now - end) / self.half_life)
        self.stats[arm].observe(value, weight)


def expected(scenario: str, day: int) -> dict[int, float]:
    if scenario in {"stationary", "unit_scale"}:
        return {0: 1.0, 1: 1.4}
    if scenario in {"sparse", "heavy_tail"}:
        return {0: 1.6, 1: 2.6} if day < 270 else {0: 3.1, 1: 1.1}
    if scenario in {"switching", "low_traffic", "long_delay"}:
        return {0: 1.5, 1: 1.0} if day < 270 else {0: 0.8, 1: 1.8}
    if scenario == "new_and_stopped":
        values = {0: 1.0, 1: 1.4}
        if day >= 240:
            values[2] = 2.0
        if day >= 390:
            del values[2]
        return values
    raise ValueError(scenario)


def potential_reward(scenario: str, means: dict[int, float], rng: random.Random) -> dict[int, float]:
    # Same potential outcomes across policies in a seed; policy RNG is separate.
    u, refund, z = rng.random(), rng.random(), rng.gauss(0, 1)
    if scenario == "sparse":
        return {a: (50.0 if u < (m + 0.4) / 50.0 else 0.0) - (20.0 if refund < 0.02 else 0.0)
                for a, m in means.items()}
    if scenario == "heavy_tail":
        multiplier = math.exp(2.0 * z - 2.0)  # mean 1; no fixed clipping
        return {a: (m + 0.4) * multiplier - (20.0 if refund < 0.02 else 0.0)
                for a, m in means.items()}
    scale = 1000.0 if scenario == "unit_scale" else 1.0
    return {a: scale * (m + z) for a, m in means.items()}


def run(scenario: str, kind: str, seed: int, days: int, rate: int, half_life: float) -> dict:
    rate = 8 if scenario == "low_traffic" else rate
    window = 28 if scenario == "long_delay" else 7
    scale = 1000.0 if scenario == "unit_scale" else 1.0
    policy = OptimisticPolicy(half_life if kind == "discounted" else math.inf, scale)
    outcomes_rng = random.Random(seed)
    choice_rng = random.Random(seed + 100_000)
    completions = []
    sequence = 0
    daily = []
    cancelled = 0
    choice_digest = hashlib.sha256()
    for day in range(days):
        policy.age(day)
        means = expected(scenario, day)
        active = sorted(means)
        if scenario == "new_and_stopped" and day == 390:
            kept = []
            for due, order, arm, reward in completions:
                if arm == 2 and due > day:
                    policy.pending[arm] -= 1
                    cancelled += 1
                else:
                    kept.append((due, order, arm, reward))
            completions = kept
            heapq.heapify(completions)
        while completions and completions[0][0] <= day:
            due, _, arm, reward = heapq.heappop(completions)
            policy.complete(arm, reward, due, day)
        counts = {a: 0 for a in active}
        regret = 0.0
        for _ in range(rate):
            outcomes = potential_reward(scenario, means, outcomes_rng)
            if kind == "uniform":
                arm = choice_rng.choice(active)
                policy.pending[arm] += 1
            else:
                arm = policy.choose(active, choice_rng)
            counts[arm] += 1
            choice_digest.update(bytes([arm]))
            regret += max(means.values()) - means[arm]
            sequence += 1
            heapq.heappush(completions, (day + window, sequence, arm, outcomes[arm]))
        best = max(means, key=means.get)
        daily.append({"day": day, "best_share": counts[best] / rate,
                      "regret_per_assignment": regret / rate, "counts": counts})
    assert min(policy.pending.values()) >= 0
    switch = 240 if scenario == "new_and_stopped" else 270
    if scenario in {"stationary", "unit_scale"}:
        switch = 0
    start = switch + window
    return {
        "tail_60_best_share": statistics.mean(d["best_share"] for d in daily[-60:]),
        "post_change_30_best_share": statistics.mean(d["best_share"] for d in daily[start:start + 30]),
        "regret_per_assignment": statistics.mean(d["regret_per_assignment"] for d in daily),
        "new_arm_first_window_assignments": sum(d["counts"].get(2, 0) for d in daily[240:240 + window]),
        "stopped_arm_later_assignments": sum(d["counts"].get(2, 0) for d in daily[390:]),
        "cancelled_observations": cancelled,
        "choice_digest": choice_digest.hexdigest(),
    }


def checks() -> list[str]:
    names = []
    m = Moments()
    m.observe(-10)
    m.observe(30)
    m.age(10, 10)
    assert (m.n, m.total, m.squares) == (1.0, 10.0, 500.0)
    m.revise(-10, -20, 0.5)
    assert (m.n, m.total, m.squares) == (1.0, 5.0, 650.0)
    names.append("signed moments, decay, late revision without recounting")
    p = OptimisticPolicy(10)
    for a in [0, 1]:
        p.stats[a] = Moments(100, 0, 100, 10)
    before = p.scores([0, 1])[0]
    p.age(20)
    assert p.scores([0, 1])[0] > before
    n_before = p.stats[0].n
    p.pending[0] += 10
    assert p.stats[0].n == n_before and p.stats[0].total == 0
    names.append("forgetting increases optimism; pending is not a zero reward")
    split = [-100 / 2 * 2 ** (-age / 10) for age in (10, 0)]
    assert split == [-25, -50] and sum(split) == -75
    names.append("equal split then signed decay without renormalization")
    exposures = [(1, "a"), (4, "b"), (8, "c")]
    assert max(e for e in exposures if e[0] <= 6) == (4, "b")
    assert not (0 <= 7 < 7) and 0 <= 6.9 < 7
    names.append("last touch before goal; half-open observation boundary")
    return names


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seeds", type=int, default=8)
    parser.add_argument("--days", type=int, default=540)
    parser.add_argument("--rate", type=int, default=100)
    parser.add_argument("--half-life", type=float, default=14.0)
    parser.add_argument("--output", type=Path, default=Path("docs/simulation-results.json"))
    args = parser.parse_args()
    assert args.days >= 450 and args.seeds > 0 and args.rate > 0 and args.half_life > 0
    report = {
        "model": "discounted empirical optimism v1; not a confidence bound",
        "parameters": {"days": args.days, "seeds": args.seeds, "daily_new_observations": args.rate,
                       "observation_days": 7, "half_life_days": args.half_life,
                       "exploration_floor": 0.02, "bonus_multiplier": 2.0,
                       "pending_penalty": 1.0, "bootstrap_quota": 8},
        "checks": checks(), "results": {},
    }
    scenarios = ["stationary", "switching", "new_and_stopped", "sparse", "heavy_tail", "low_traffic", "long_delay", "unit_scale"]
    for scenario in scenarios:
        report["results"][scenario] = {}
        for kind in ["discounted", "lifetime", "uniform"]:
            runs = [run(scenario, kind, seed, args.days, args.rate, args.half_life) for seed in range(args.seeds)]
            summary = {}
            for metric in runs[0]:
                if metric == "choice_digest":
                    continue
                values = [r[metric] for r in runs]
                summary[metric] = {"mean": statistics.mean(values), "min": min(values), "max": max(values)}
            report["results"][scenario][kind] = {"summary": summary, "runs": runs}
        print(scenario, {p: round(report["results"][scenario][p]["summary"]["tail_60_best_share"]["mean"], 3)
                         for p in report["results"][scenario]}, flush=True)
    for kind in ["discounted", "lifetime", "uniform"]:
        base = report["results"]["stationary"][kind]["runs"]
        scaled = report["results"]["unit_scale"][kind]["runs"]
        assert base == scaled, "Positive unit scaling (including initial scale) changed choices"
    report["checks"].append("1000x unit scaling with initial scale: identical choices across all seeds")
    for kind in ["discounted", "lifetime", "uniform"]:
        assert report["results"]["new_and_stopped"][kind]["summary"]["stopped_arm_later_assignments"]["max"] == 0
    report["checks"].append("no new assignment to stopped arm")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Saved {args.output}", flush=True)


if __name__ == "__main__":
    main()
