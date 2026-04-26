import { z } from "zod";

import {
  AiRebalanceDecisionSchema,
  RebalancePoolSnapshotSchema,
  RebalancePositionSnapshotSchema,
  RebalanceReviewInputSchema,
  type AiRebalanceDecision,
  type RebalancePlan,
  type RebalancePoolSnapshot,
  type RebalancePositionSnapshot,
  type RebalanceReviewInput,
} from "../entities/RebalanceDecision.js";

export const AiRebalanceModeSchema = z.enum([
  "advisory",
  "dry_run",
  "constrained_action",
]);

export const RebalanceDecisionValidationPolicySchema = z
  .object({
    minAiRebalanceConfidence: z.number().min(0).max(1).default(0.78),
    maxRebalancesPerPosition: z.number().int().nonnegative().default(2),
    minPositionAgeMinutesBeforeRebalance: z
      .number()
      .int()
      .nonnegative()
      .default(8),
    rebalanceCooldownMinutes: z.number().int().nonnegative().default(20),
    maxOutOfRangeMinutes: z.number().int().nonnegative().default(5),
    rebalanceEdgeThresholdPct: z.number().min(0).max(1).default(0.1),
    maxRebalanceBinsBelow: z.number().int().nonnegative().default(90),
    maxRebalanceBinsAbove: z.number().int().nonnegative().default(90),
    maxRebalanceSlippageBps: z
      .number()
      .int()
      .positive()
      .max(10_000)
      .default(150),
    requireFreshActiveBin: z.boolean().default(true),
    maxActiveBinDrift: z.number().int().nonnegative().default(3),
    requireRebalanceSimulation: z.boolean().default(true),
    exitInsteadOfRebalanceWhenRiskHigh: z.boolean().default(true),
    minTvlUsd: z.number().nonnegative().default(0),
    expectedFeeImprovementUsd: z.number().nonnegative().optional(),
    estimatedCloseCostUsd: z.number().nonnegative().optional(),
    estimatedRedeployCostUsd: z.number().nonnegative().optional(),
    safetyMarginUsd: z.number().nonnegative().default(0),
    closeSimulationPassed: z.boolean().optional(),
    redeploySimulationPassed: z.boolean().optional(),
  })
  .strict();

export const RebalanceDecisionValidationResultSchema = z
  .object({
    allowed: z.boolean(),
    action: z.enum(["hold", "claim_only", "rebalance_same_pool", "exit"]),
    rebalancePlan: z
      .object({
        strategy: z.enum(["spot", "curve", "bid_ask"]),
        binsBelow: z.number().int().nonnegative(),
        binsAbove: z.number().int().nonnegative(),
        slippageBps: z.number().int().nonnegative(),
        maxPositionAgeMinutes: z.number().int().nonnegative(),
        stopLossPct: z.number().nonnegative(),
        takeProfitPct: z.number().nonnegative(),
        trailingStopPct: z.number().nonnegative(),
      })
      .strict()
      .nullable(),
    reasonCodes: z.array(z.string().min(1)),
    riskFlags: z.array(z.string().min(1)),
  })
  .strict();

export type AiRebalanceMode = z.infer<typeof AiRebalanceModeSchema>;
export type RebalanceDecisionValidationPolicy = z.infer<
  typeof RebalanceDecisionValidationPolicySchema
>;
export type RebalanceDecisionValidationResult = z.infer<
  typeof RebalanceDecisionValidationResultSchema
>;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function reject(input: {
  decision: AiRebalanceDecision;
  reasonCodes: string[];
  riskFlags: string[];
}): RebalanceDecisionValidationResult {
  return RebalanceDecisionValidationResultSchema.parse({
    allowed: false,
    action: input.decision.action,
    rebalancePlan: input.decision.rebalancePlan,
    reasonCodes: unique(input.reasonCodes),
    riskFlags: unique(input.riskFlags),
  });
}

function validateRebalancePlan(input: {
  plan: RebalancePlan;
  position: RebalancePositionSnapshot;
  pool: RebalancePoolSnapshot;
  policy: RebalanceDecisionValidationPolicy;
}): { reasonCodes: string[]; riskFlags: string[] } {
  const reasonCodes: string[] = [];
  const riskFlags: string[] = [];

  if (input.plan.binsBelow > input.policy.maxRebalanceBinsBelow) {
    reasonCodes.push("rebalance_bins_below_above_limit");
    riskFlags.push("rebalance_bins_below_above_limit");
  }
  if (input.plan.binsAbove > input.policy.maxRebalanceBinsAbove) {
    reasonCodes.push("rebalance_bins_above_above_limit");
    riskFlags.push("rebalance_bins_above_above_limit");
  }
  if (input.plan.slippageBps <= 0) {
    reasonCodes.push("rebalance_slippage_missing");
    riskFlags.push("rebalance_slippage_missing");
  }
  if (input.plan.slippageBps > input.policy.maxRebalanceSlippageBps) {
    reasonCodes.push("rebalance_slippage_above_limit");
    riskFlags.push("rebalance_slippage_above_limit");
  }
  if (input.plan.maxPositionAgeMinutes <= 0) {
    reasonCodes.push("rebalance_max_position_age_missing");
    riskFlags.push("rebalance_max_position_age_missing");
  }
  if (input.plan.stopLossPct <= 0) {
    reasonCodes.push("rebalance_stop_loss_missing");
    riskFlags.push("rebalance_stop_loss_missing");
  }
  if (input.plan.takeProfitPct <= 0) {
    reasonCodes.push("rebalance_take_profit_missing");
    riskFlags.push("rebalance_take_profit_missing");
  }
  if (input.pool.tvlUsd < input.policy.minTvlUsd) {
    reasonCodes.push("rebalance_pool_tvl_below_minimum");
    riskFlags.push("rebalance_pool_tvl_below_minimum");
  }
  if (input.pool.liquidityDepthNearActive === "shallow") {
    reasonCodes.push("rebalance_depth_too_shallow");
    riskFlags.push("rebalance_depth_too_shallow");
  }
  if (
    input.policy.requireFreshActiveBin &&
    input.pool.currentActiveBin === null
  ) {
    reasonCodes.push("rebalance_fresh_active_bin_unavailable");
    riskFlags.push("rebalance_fresh_active_bin_unavailable");
  }
  if (
    input.pool.currentActiveBin !== null &&
    input.position.currentActiveBin !== null &&
    Math.abs(input.pool.currentActiveBin - input.position.currentActiveBin) >
      input.policy.maxActiveBinDrift
  ) {
    reasonCodes.push("rebalance_active_bin_drift_above_limit");
    riskFlags.push("rebalance_active_bin_drift_above_limit");
  }
  if (
    input.policy.requireRebalanceSimulation &&
    input.policy.closeSimulationPassed !== true
  ) {
    reasonCodes.push("rebalance_close_simulation_failed");
    riskFlags.push("rebalance_close_simulation_failed");
  }
  if (
    input.policy.requireRebalanceSimulation &&
    input.policy.redeploySimulationPassed !== true
  ) {
    reasonCodes.push("rebalance_redeploy_simulation_failed");
    riskFlags.push("rebalance_redeploy_simulation_failed");
  }

  const expectedImprovement = input.policy.expectedFeeImprovementUsd;
  if (expectedImprovement !== undefined) {
    const requiredImprovement =
      (input.policy.estimatedCloseCostUsd ?? 0) +
      (input.policy.estimatedRedeployCostUsd ?? 0) +
      input.policy.safetyMarginUsd;
    if (expectedImprovement <= requiredImprovement) {
      reasonCodes.push("rebalance_improvement_does_not_cover_cost");
      riskFlags.push("rebalance_improvement_does_not_cover_cost");
    }
  }

  return { reasonCodes, riskFlags };
}

export function validateRebalanceDecision(input: {
  decision: AiRebalanceDecision;
  review: RebalanceReviewInput;
  policy?: Partial<RebalanceDecisionValidationPolicy>;
}): RebalanceDecisionValidationResult {
  const decision = AiRebalanceDecisionSchema.parse(input.decision);
  const review = RebalanceReviewInputSchema.parse(input.review);
  const policy = RebalanceDecisionValidationPolicySchema.parse(
    input.policy ?? {},
  );
  const reasonCodes: string[] = [];
  const riskFlags: string[] = [];

  if (decision.confidence < policy.minAiRebalanceConfidence) {
    reasonCodes.push("ai_rebalance_confidence_below_minimum");
    riskFlags.push("low_ai_rebalance_confidence");
  }
  if (
    decision.riskLevel === "high" &&
    decision.action !== "exit" &&
    policy.exitInsteadOfRebalanceWhenRiskHigh
  ) {
    reasonCodes.push("ai_rebalance_high_risk_must_exit");
    riskFlags.push("ai_rebalance_high_risk");
  }
  if (
    review.position.rebalanceCount >= policy.maxRebalancesPerPosition &&
    decision.action === "rebalance_same_pool"
  ) {
    reasonCodes.push("max_rebalances_per_position_reached");
    riskFlags.push("max_rebalances_per_position_reached");
  }
  if (
    review.position.ageMinutes < policy.minPositionAgeMinutesBeforeRebalance &&
    decision.action === "rebalance_same_pool"
  ) {
    reasonCodes.push("position_too_young_for_rebalance");
    riskFlags.push("position_too_young_for_rebalance");
  }
  if (
    decision.action === "rebalance_same_pool" &&
    policy.rebalanceCooldownMinutes > 0 &&
    review.position.rebalanceCount > 0
  ) {
    const lastRebalanceAgeMinutes =
      review.position.lastRebalanceAgeMinutes ?? null;
    if (lastRebalanceAgeMinutes === null) {
      reasonCodes.push("rebalance_cooldown_unverifiable");
      riskFlags.push("rebalance_cooldown_unverifiable");
    } else if (lastRebalanceAgeMinutes < policy.rebalanceCooldownMinutes) {
      reasonCodes.push("rebalance_cooldown_active");
      riskFlags.push("rebalance_cooldown_active");
    }
  }
  if (
    decision.action === "rebalance_same_pool" &&
    decision.rebalancePlan !== null
  ) {
    const planBlockers = validateRebalancePlan({
      plan: decision.rebalancePlan,
      position: review.position,
      pool: review.pool,
      policy,
    });
    reasonCodes.push(...planBlockers.reasonCodes);
    riskFlags.push(...planBlockers.riskFlags);
  }

  if (reasonCodes.length > 0 || riskFlags.length > 0) {
    return reject({ decision, reasonCodes, riskFlags });
  }

  return RebalanceDecisionValidationResultSchema.parse({
    allowed: true,
    action: decision.action,
    rebalancePlan: decision.rebalancePlan,
    reasonCodes: [`ai_rebalance_${decision.action}_allowed`],
    riskFlags: [],
  });
}

export function deriveRebalanceTriggerSnapshot(input: {
  position: RebalancePositionSnapshot;
  pool: RebalancePoolSnapshot;
  maxOutOfRangeMinutes: number;
  rebalanceEdgeThresholdPct: number;
  minPositionAgeMinutesBeforeRebalance: number;
}): string[] {
  const position = RebalancePositionSnapshotSchema.parse(input.position);
  const pool = RebalancePoolSnapshotSchema.parse(input.pool);
  const triggers: string[] = [];

  if (
    position.outOfRangeMinutes >= input.maxOutOfRangeMinutes &&
    input.maxOutOfRangeMinutes > 0
  ) {
    triggers.push("out_of_range_duration");
  }

  const rangeWidth = position.upperBin - position.lowerBin;
  if (
    rangeWidth > 0 &&
    position.currentActiveBin !== null &&
    position.ageMinutes >= input.minPositionAgeMinutesBeforeRebalance
  ) {
    const distanceToLower = position.currentActiveBin - position.lowerBin;
    const distanceToUpper = position.upperBin - position.currentActiveBin;
    const edgeDistancePct =
      Math.min(distanceToLower, distanceToUpper) / rangeWidth;
    if (
      edgeDistancePct >= 0 &&
      edgeDistancePct < input.rebalanceEdgeThresholdPct
    ) {
      triggers.push("near_range_edge");
    }
  }

  if (pool.liquidityDepthNearActive === "shallow") {
    triggers.push("pool_depth_shallow");
  }
  if (
    Math.abs(pool.priceChange15mPct) >= 15 ||
    Math.abs(pool.priceChange1hPct) >= 25
  ) {
    triggers.push("one_way_price_move");
  }

  return unique(triggers);
}
