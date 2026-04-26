import { CandidateSchema, type Candidate } from "../entities/Candidate.js";

export type EnrichmentSkipReason =
  | "outside_top_n"
  | "cycle_budget_exhausted"
  | "endpoint_in_cooldown";

export interface EnrichmentPlan {
  selectedForDetail: Candidate[];
  skipped: Array<{
    candidateId: string;
    poolAddress: string;
    reason: EnrichmentSkipReason;
  }>;
}

function isCooldownActive(input: {
  now: string;
  endpointCooldownUntil?: string | null;
}): boolean {
  if (
    input.endpointCooldownUntil === null ||
    input.endpointCooldownUntil === undefined
  ) {
    return false;
  }

  const nowMs = Date.parse(input.now);
  const cooldownMs = Date.parse(input.endpointCooldownUntil);
  return (
    Number.isFinite(nowMs) && Number.isFinite(cooldownMs) && cooldownMs > nowMs
  );
}

function sortByCoarseScore(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((left, right) => {
    const scoreOrder = right.score - left.score;
    if (scoreOrder !== 0) {
      return scoreOrder;
    }

    const pairOrder = left.symbolPair.localeCompare(right.symbolPair);
    if (pairOrder !== 0) {
      return pairOrder;
    }

    return left.candidateId.localeCompare(right.candidateId);
  });
}

export function buildEnrichmentPlan(input: {
  candidates: Candidate[];
  topN: number;
  maxDetailRequestsPerCycle: number;
  now: string;
  endpointCooldownUntil?: string | null;
}): EnrichmentPlan {
  const candidates = CandidateSchema.array().parse(input.candidates);
  const topN = Math.max(0, Math.floor(input.topN));
  const maxDetailRequestsPerCycle = Math.max(
    0,
    Math.floor(input.maxDetailRequestsPerCycle),
  );

  if (
    isCooldownActive({
      now: input.now,
      endpointCooldownUntil: input.endpointCooldownUntil ?? null,
    })
  ) {
    return {
      selectedForDetail: [],
      skipped: candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        poolAddress: candidate.poolAddress,
        reason: "endpoint_in_cooldown",
      })),
    };
  }

  const sorted = sortByCoarseScore(candidates);
  const selectedLimit = Math.min(topN, maxDetailRequestsPerCycle);
  const selectedForDetail = sorted.slice(0, selectedLimit);
  const selectedIds = new Set(
    selectedForDetail.map((candidate) => candidate.candidateId),
  );
  const topNIds = new Set(
    sorted.slice(0, topN).map((candidate) => candidate.candidateId),
  );

  return {
    selectedForDetail,
    skipped: sorted
      .filter((candidate) => !selectedIds.has(candidate.candidateId))
      .map((candidate) => ({
        candidateId: candidate.candidateId,
        poolAddress: candidate.poolAddress,
        reason: topNIds.has(candidate.candidateId)
          ? "cycle_budget_exhausted"
          : "outside_top_n",
      })),
  };
}
