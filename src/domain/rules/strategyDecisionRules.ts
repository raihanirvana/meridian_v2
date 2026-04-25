import { z } from "zod";

import type { StrategyReviewResult } from "../../adapters/llm/AiStrategyReviewer.js";
import {
  CandidateSchema,
  type Candidate,
  type StrategySuitability,
} from "../entities/Candidate.js";

export const StrategyDecisionModeSchema = z.enum([
  "recommendation_only",
  "dry_run_payload",
  "manual_live",
  "guarded_auto",
]);

export const StrategyFallbackModeSchema = z.enum([
  "config_static",
  "deterministic_best",
  "reject",
]);

export const DeployStrategySchema = z.enum(["spot", "curve", "bid_ask"]);

export const StrategyDecisionValidationPolicySchema = z
  .object({
    minCandidateScore: z.number().min(0).max(100).default(0),
    minAiStrategyConfidence: z.number().min(0).max(1).default(0.7),
    allowedStrategies: z
      .array(DeployStrategySchema)
      .min(1)
      .default(["spot", "curve", "bid_ask"]),
    maxActiveBinDrift: z.number().int().nonnegative().default(3),
    maxBinsBelow: z.number().int().nonnegative().default(120),
    maxBinsAbove: z.number().int().nonnegative().default(120),
    maxSlippageBps: z.number().int().positive().default(300),
    requireFreshSnapshot: z.boolean().default(true),
    strategyFallbackMode: StrategyFallbackModeSchema.default("config_static"),
  })
  .strict();

export const StrategyDecisionDefaultsSchema = z
  .object({
    strategy: DeployStrategySchema,
    binsBelow: z.number().int().nonnegative(),
    binsAbove: z.number().int().nonnegative(),
    slippageBps: z.number().int().positive(),
  })
  .strict();

export const FinalStrategyDecisionSchema = z
  .object({
    source: z.enum(["CONFIG_STATIC", "DETERMINISTIC", "AI", "REJECTED"]),
    mode: StrategyDecisionModeSchema,
    decision: z.enum(["deploy", "watch", "reject"]),
    strategy: DeployStrategySchema.nullable(),
    binsBelow: z.number().int().nonnegative(),
    binsAbove: z.number().int().nonnegative(),
    slippageBps: z.number().int().positive(),
    confidence: z.number().min(0).max(1),
    reasonCodes: z.array(z.string().min(1)),
    riskFlags: z.array(z.string().min(1)),
    rejected: z.boolean(),
    aiRecommendedStrategy: z.string().min(1).nullable(),
    deterministicStrategy: z.string().min(1).nullable(),
    configStrategy: DeployStrategySchema,
  })
  .strict();

export type StrategyDecisionMode = z.infer<typeof StrategyDecisionModeSchema>;
export type StrategyFallbackMode = z.infer<typeof StrategyFallbackModeSchema>;
export type DeployStrategy = z.infer<typeof DeployStrategySchema>;
export type StrategyDecisionValidationPolicy = z.infer<
  typeof StrategyDecisionValidationPolicySchema
>;
export type StrategyDecisionDefaults = z.infer<
  typeof StrategyDecisionDefaultsSchema
>;
export type FinalStrategyDecision = z.infer<typeof FinalStrategyDecisionSchema>;

export interface ValidateStrategyDecisionInput {
  candidate: Candidate;
  mode?: StrategyDecisionMode;
  aiReview?: StrategyReviewResult | null;
  configStrategy: StrategyDecisionDefaults;
  policy?: Partial<StrategyDecisionValidationPolicy>;
  simulationPassed?: boolean;
  simulationError?: string | null;
}

function toDeployStrategy(value: string): DeployStrategy | null {
  const parsed = DeployStrategySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function bestDeterministicStrategy(
  suitability: StrategySuitability,
): DeployStrategy | null {
  return toDeployStrategy(suitability.recommendedByRules);
}

function rejectDecision(input: {
  candidate: Candidate;
  mode: StrategyDecisionMode;
  configStrategy: StrategyDecisionDefaults;
  reasonCodes: string[];
  riskFlags: string[];
  aiReview?: StrategyReviewResult | null;
}): FinalStrategyDecision {
  return FinalStrategyDecisionSchema.parse({
    source: "REJECTED",
    mode: input.mode,
    decision: "reject",
    strategy: null,
    binsBelow: input.configStrategy.binsBelow,
    binsAbove: input.configStrategy.binsAbove,
    slippageBps: input.configStrategy.slippageBps,
    confidence: input.aiReview?.confidence ?? 0,
    reasonCodes: input.reasonCodes,
    riskFlags: input.riskFlags,
    rejected: true,
    aiRecommendedStrategy: input.aiReview?.recommendedStrategy ?? null,
    deterministicStrategy:
      input.candidate.strategySuitability.recommendedByRules === "none"
        ? null
        : input.candidate.strategySuitability.recommendedByRules,
    configStrategy: input.configStrategy.strategy,
  });
}

function fallbackDecision(input: {
  candidate: Candidate;
  mode: StrategyDecisionMode;
  configStrategy: StrategyDecisionDefaults;
  policy: StrategyDecisionValidationPolicy;
  reasonCodes: string[];
  riskFlags: string[];
  aiReview?: StrategyReviewResult | null;
}): FinalStrategyDecision {
  if (input.policy.strategyFallbackMode === "reject") {
    return rejectDecision(input);
  }

  const deterministicStrategy = bestDeterministicStrategy(
    input.candidate.strategySuitability,
  );
  if (
    input.policy.strategyFallbackMode === "deterministic_best" &&
    deterministicStrategy !== null &&
    input.policy.allowedStrategies.includes(deterministicStrategy)
  ) {
    return FinalStrategyDecisionSchema.parse({
      source: "DETERMINISTIC",
      mode: input.mode,
      decision: "deploy",
      strategy: deterministicStrategy,
      binsBelow: input.configStrategy.binsBelow,
      binsAbove: input.configStrategy.binsAbove,
      slippageBps: input.configStrategy.slippageBps,
      confidence: 0.65,
      reasonCodes: [...input.reasonCodes, "fallback_to_deterministic_strategy"],
      riskFlags: input.riskFlags,
      rejected: false,
      aiRecommendedStrategy: input.aiReview?.recommendedStrategy ?? null,
      deterministicStrategy,
      configStrategy: input.configStrategy.strategy,
    });
  }

  return FinalStrategyDecisionSchema.parse({
    source: "CONFIG_STATIC",
    mode: input.mode,
    decision: "deploy",
    strategy: input.configStrategy.strategy,
    binsBelow: input.configStrategy.binsBelow,
    binsAbove: input.configStrategy.binsAbove,
    slippageBps: input.configStrategy.slippageBps,
    confidence: 1,
    reasonCodes: [...input.reasonCodes, "fallback_to_config_static_strategy"],
    riskFlags: input.riskFlags,
    rejected: false,
    aiRecommendedStrategy: input.aiReview?.recommendedStrategy ?? null,
    deterministicStrategy,
    configStrategy: input.configStrategy.strategy,
  });
}

function collectCandidateBlockers(input: {
  candidate: Candidate;
  policy: StrategyDecisionValidationPolicy;
  simulationPassed: boolean;
  simulationError: string | null;
}): { reasonCodes: string[]; riskFlags: string[] } {
  const reasonCodes: string[] = [];
  const riskFlags: string[] = [
    ...input.candidate.strategySuitability.strategyRiskFlags,
  ];

  if (!input.candidate.hardFilterPassed) {
    reasonCodes.push("candidate_failed_hard_filter");
    riskFlags.push("hard_filter_failed");
  }
  if (input.candidate.score < input.policy.minCandidateScore) {
    reasonCodes.push("candidate_score_below_minimum");
    riskFlags.push("low_candidate_score");
  }
  if (
    input.policy.requireFreshSnapshot &&
    !input.candidate.dataFreshnessSnapshot.isFreshEnoughForDeploy
  ) {
    reasonCodes.push("strategy_snapshot_stale");
    riskFlags.push("stale_strategy_snapshot");
  }
  if (input.candidate.dlmmMicrostructureSnapshot.activeBin === null) {
    reasonCodes.push("active_bin_unavailable");
    riskFlags.push("missing_active_bin");
  }
  if (
    input.candidate.dlmmMicrostructureSnapshot.activeBinDriftFromDiscovery >
    input.policy.maxActiveBinDrift
  ) {
    reasonCodes.push("active_bin_drift_above_limit");
    riskFlags.push("active_bin_drift_above_limit");
  }
  if (
    input.candidate.dlmmMicrostructureSnapshot
      .estimatedSlippageBpsForDefaultSize > input.policy.maxSlippageBps
  ) {
    reasonCodes.push("estimated_slippage_above_limit");
    riskFlags.push("estimated_slippage_above_limit");
  }
  if (!input.simulationPassed) {
    reasonCodes.push("dlmm_simulation_failed");
    riskFlags.push("simulation_failed");
  }

  return {
    reasonCodes: [...new Set(reasonCodes)],
    riskFlags: [...new Set(riskFlags)],
  };
}

function collectAiBlockers(input: {
  aiReview: StrategyReviewResult;
  candidate: Candidate;
  policy: StrategyDecisionValidationPolicy;
}): { reasonCodes: string[]; riskFlags: string[] } {
  const reasonCodes: string[] = [];
  const riskFlags: string[] = [];
  const strategy = toDeployStrategy(input.aiReview.recommendedStrategy);

  if (input.aiReview.decision !== "deploy") {
    reasonCodes.push(`ai_decision_${input.aiReview.decision}`);
  }
  if (input.aiReview.confidence < input.policy.minAiStrategyConfidence) {
    reasonCodes.push("ai_confidence_below_minimum");
    riskFlags.push("low_ai_confidence");
  }
  if (input.aiReview.riskLevel === "high") {
    reasonCodes.push("ai_risk_level_high");
    riskFlags.push("ai_high_risk");
  }
  if (strategy === null) {
    reasonCodes.push("ai_strategy_not_deployable");
    riskFlags.push("invalid_ai_strategy");
  } else if (!input.policy.allowedStrategies.includes(strategy)) {
    reasonCodes.push("ai_strategy_not_allowlisted");
    riskFlags.push("strategy_not_allowlisted");
  }
  if (input.aiReview.binsBelow > input.policy.maxBinsBelow) {
    reasonCodes.push("ai_bins_below_above_limit");
    riskFlags.push("bins_below_above_limit");
  }
  if (input.aiReview.binsAbove > input.policy.maxBinsAbove) {
    reasonCodes.push("ai_bins_above_above_limit");
    riskFlags.push("bins_above_above_limit");
  }
  if (input.aiReview.slippageBps > input.policy.maxSlippageBps) {
    reasonCodes.push("ai_slippage_above_limit");
    riskFlags.push("slippage_above_limit");
  }
  if (input.aiReview.decision === "deploy" && input.aiReview.slippageBps <= 0) {
    reasonCodes.push("ai_slippage_missing_for_deploy");
    riskFlags.push("missing_deploy_slippage");
  }
  if (
    input.aiReview.decision === "deploy" &&
    input.aiReview.maxPositionAgeMinutes <= 0
  ) {
    reasonCodes.push("ai_max_position_age_missing_for_deploy");
    riskFlags.push("missing_deploy_max_position_age");
  }
  if (input.aiReview.decision === "deploy" && input.aiReview.stopLossPct <= 0) {
    reasonCodes.push("ai_stop_loss_missing_for_deploy");
    riskFlags.push("missing_deploy_stop_loss");
  }
  if (
    input.aiReview.decision === "deploy" &&
    input.aiReview.takeProfitPct <= 0
  ) {
    reasonCodes.push("ai_take_profit_missing_for_deploy");
    riskFlags.push("missing_deploy_take_profit");
  }
  if (
    strategy === "bid_ask" &&
    (input.candidate.strategySuitability.strategyRiskFlags.includes(
      "one_way_price_move",
    ) ||
      Math.abs(input.candidate.marketFeatureSnapshot.priceChange15mPct) >= 15 ||
      Math.abs(input.candidate.marketFeatureSnapshot.priceChange1hPct) >= 25)
  ) {
    reasonCodes.push("ai_bid_ask_rejected_for_one_way_trend");
    riskFlags.push("bid_ask_one_way_trend");
  }
  if (
    strategy === "curve" &&
    (input.candidate.marketFeatureSnapshot.volatility1hPct >= 8 ||
      input.candidate.marketFeatureSnapshot.trendStrength1h >= 60)
  ) {
    reasonCodes.push("ai_curve_rejected_for_high_volatility");
    riskFlags.push("curve_high_volatility");
  }

  return {
    reasonCodes: [...new Set(reasonCodes)],
    riskFlags: [...new Set(riskFlags)],
  };
}

export function validateStrategyDecision(
  input: ValidateStrategyDecisionInput,
): FinalStrategyDecision {
  const candidate = CandidateSchema.parse(input.candidate);
  const mode = StrategyDecisionModeSchema.parse(
    input.mode ?? "recommendation_only",
  );
  const configStrategy = StrategyDecisionDefaultsSchema.parse(
    input.configStrategy,
  );
  const policy = StrategyDecisionValidationPolicySchema.parse(
    input.policy ?? {},
  );
  const simulationPassed = input.simulationPassed ?? true;
  const simulationError = input.simulationError ?? null;
  const candidateBlockers = collectCandidateBlockers({
    candidate,
    policy,
    simulationPassed,
    simulationError,
  });

  if (candidateBlockers.riskFlags.length > 0) {
    return rejectDecision({
      candidate,
      mode,
      configStrategy,
      reasonCodes: candidateBlockers.reasonCodes,
      riskFlags: candidateBlockers.riskFlags,
      ...(input.aiReview === undefined ? {} : { aiReview: input.aiReview }),
    });
  }

  if (mode === "recommendation_only" || input.aiReview === null) {
    return fallbackDecision({
      candidate,
      mode,
      configStrategy,
      policy: {
        ...policy,
        strategyFallbackMode:
          mode === "recommendation_only"
            ? "config_static"
            : policy.strategyFallbackMode,
      },
      reasonCodes:
        mode === "recommendation_only"
          ? ["ai_recommendation_recorded_only"]
          : [],
      riskFlags: [],
      aiReview: input.aiReview ?? null,
    });
  }

  if (input.aiReview === undefined) {
    return fallbackDecision({
      candidate,
      mode,
      configStrategy,
      policy,
      reasonCodes: ["ai_review_unavailable"],
      riskFlags: [],
      aiReview: null,
    });
  }

  const aiBlockers = collectAiBlockers({
    aiReview: input.aiReview,
    candidate,
    policy,
  });
  if (aiBlockers.riskFlags.length > 0 || aiBlockers.reasonCodes.length > 0) {
    return rejectDecision({
      candidate,
      mode,
      configStrategy,
      reasonCodes: aiBlockers.reasonCodes,
      riskFlags: aiBlockers.riskFlags,
      ...(input.aiReview === undefined ? {} : { aiReview: input.aiReview }),
    });
  }

  const strategy = toDeployStrategy(input.aiReview.recommendedStrategy);
  if (strategy === null) {
    return fallbackDecision({
      candidate,
      mode,
      configStrategy,
      policy,
      reasonCodes: ["ai_strategy_not_deployable"],
      riskFlags: ["invalid_ai_strategy"],
      ...(input.aiReview === undefined ? {} : { aiReview: input.aiReview }),
    });
  }

  return FinalStrategyDecisionSchema.parse({
    source: "AI",
    mode,
    decision: "deploy",
    strategy,
    binsBelow: input.aiReview.binsBelow,
    binsAbove: input.aiReview.binsAbove,
    slippageBps: input.aiReview.slippageBps,
    confidence: input.aiReview.confidence,
    reasonCodes: input.aiReview.reasons,
    riskFlags: [],
    rejected: false,
    aiRecommendedStrategy: input.aiReview.recommendedStrategy,
    deterministicStrategy:
      candidate.strategySuitability.recommendedByRules === "none"
        ? null
        : candidate.strategySuitability.recommendedByRules,
    configStrategy: configStrategy.strategy,
  });
}
