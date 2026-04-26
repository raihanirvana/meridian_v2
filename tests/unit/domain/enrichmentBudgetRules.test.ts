import { describe, expect, it } from "vitest";

import { CandidateSchema } from "../../../src/domain/entities/Candidate.js";
import { buildEnrichmentPlan } from "../../../src/domain/rules/enrichmentBudgetRules.js";

const now = "2026-04-26T00:00:00.000Z";

function candidate(id: string, score: number) {
  return CandidateSchema.parse({
    candidateId: id,
    poolAddress: `pool_${id}`,
    symbolPair: `${id}-SOL`,
    screeningSnapshot: {},
    tokenRiskSnapshot: {},
    smartMoneySnapshot: {},
    hardFilterPassed: true,
    score,
    scoreBreakdown: {},
    decision: "PASSED_HARD_FILTER",
    decisionReason: "passed",
    createdAt: now,
  });
}

describe("buildEnrichmentPlan", () => {
  it("selects only top N candidates by deterministic score", () => {
    const plan = buildEnrichmentPlan({
      candidates: [
        candidate("low", 10),
        candidate("high", 90),
        candidate("mid", 50),
      ],
      topN: 2,
      maxDetailRequestsPerCycle: 5,
      now,
    });

    expect(plan.selectedForDetail.map((item) => item.candidateId)).toEqual([
      "high",
      "mid",
    ]);
    expect(plan.skipped).toEqual([
      {
        candidateId: "low",
        poolAddress: "pool_low",
        reason: "outside_top_n",
      },
    ]);
  });

  it("uses cycle budget before top-N budget", () => {
    const plan = buildEnrichmentPlan({
      candidates: [candidate("a", 90), candidate("b", 80), candidate("c", 70)],
      topN: 3,
      maxDetailRequestsPerCycle: 1,
      now,
    });

    expect(plan.selectedForDetail.map((item) => item.candidateId)).toEqual([
      "a",
    ]);
    expect(plan.skipped.map((item) => item.reason)).toEqual([
      "cycle_budget_exhausted",
      "cycle_budget_exhausted",
    ]);
  });

  it("selects no candidates when endpoint cooldown is active", () => {
    const plan = buildEnrichmentPlan({
      candidates: [candidate("a", 90), candidate("b", 80)],
      topN: 2,
      maxDetailRequestsPerCycle: 2,
      now,
      endpointCooldownUntil: "2026-04-26T00:10:00.000Z",
    });

    expect(plan.selectedForDetail).toHaveLength(0);
    expect(plan.skipped.map((item) => item.reason)).toEqual([
      "endpoint_in_cooldown",
      "endpoint_in_cooldown",
    ]);
  });
});
