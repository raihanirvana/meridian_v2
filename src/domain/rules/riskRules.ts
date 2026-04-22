import { z } from "zod";

import { PortfolioStateSchema, type PortfolioState } from "../entities/PortfolioState.js";
import { PositionSchema } from "../entities/Position.js";
import {
  CircuitBreakerStateSchema,
  DrawdownStateSchema,
} from "../types/enums.js";

export const PortfolioRiskActionSchema = z.enum([
  "DEPLOY",
  "REBALANCE",
  "CLOSE",
  "CLAIM_FEES",
  "PARTIAL_CLOSE",
  "RECONCILE_ONLY",
]);

export const PortfolioRiskPolicySchema = z
  .object({
    maxConcurrentPositions: z.number().int().positive(),
    maxCapitalUsagePct: z.number().min(0).max(100),
    minReserveUsd: z.number().positive(),
    maxTokenExposurePct: z.number().min(0).max(100),
    maxPoolExposurePct: z.number().min(0).max(100),
    maxRebalancesPerPosition: z.number().int().min(0),
    dailyLossLimitPct: z.number().positive(),
    maxDailyLossSol: z.number().positive().optional(),
    dailyProfitTargetSol: z.number().positive().optional(),
    circuitBreakerCooldownMin: z.number().int().positive(),
    maxNewDeploysPerHour: z.number().int().positive(),
  })
  .strict();

export const CapitalUsageSnapshotSchema = z
  .object({
    committedCapitalUsd: z.number().nonnegative(),
    deployableCapitalUsd: z.number().nonnegative(),
    freeBalanceAfterAllocationUsd: z.number(),
    currentCapitalUsagePct: z.number().min(0),
    projectedCapitalUsagePct: z.number().min(0),
  })
  .strict();

export const PortfolioRiskStateSnapshotSchema = z
  .object({
    dailyLossPct: z.number().min(0),
    dailyLossSol: z.number().min(0),
    drawdownState: DrawdownStateSchema,
    circuitBreakerState: CircuitBreakerStateSchema,
    capitalUsage: CapitalUsageSnapshotSchema,
  })
  .strict();

export const PortfolioRiskEvaluationInputSchema = z
  .object({
    action: PortfolioRiskActionSchema,
    portfolio: PortfolioStateSchema,
    policy: PortfolioRiskPolicySchema,
    proposedAllocationUsd: z.number().nonnegative().default(0),
    proposedPoolAddress: z.string().min(1).nullable().default(null),
    proposedTokenMints: z.array(z.string().min(1)).max(2).default([]),
    recentNewDeploys: z.number().int().nonnegative().default(0),
    solPriceUsd: z.number().positive().optional(),
    position: PositionSchema.nullable().default(null),
  })
  .strict()
  .superRefine((input, ctx) => {
    const needsProposal =
      input.action === "DEPLOY" || input.action === "REBALANCE";

    if (!needsProposal) {
      return;
    }

    if (input.proposedPoolAddress === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposedPoolAddress"],
        message: `must be set when action is ${input.action}`,
      });
    }

    if (input.proposedTokenMints.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposedTokenMints"],
        message: `must include at least one token mint when action is ${input.action}`,
      });
    }

    if (input.proposedAllocationUsd <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposedAllocationUsd"],
        message: `must be greater than zero when action is ${input.action}`,
      });
    }

    if (input.action === "REBALANCE" && input.position === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["position"],
        message: "must be set when action is REBALANCE",
      });
    }
  });

export const PortfolioRiskEvaluationResultSchema = z
  .object({
    action: PortfolioRiskActionSchema,
    allowed: z.boolean(),
    decision: z.enum(["ALLOW", "BLOCK"]),
    reason: z.string().min(1),
    blockingRules: z.array(z.string().min(1)),
    state: PortfolioRiskStateSnapshotSchema,
    projectedExposureByToken: z.record(z.string(), z.number().nonnegative()),
    projectedExposureByPool: z.record(z.string(), z.number().nonnegative()),
  })
  .strict();

export type PortfolioRiskAction = z.infer<typeof PortfolioRiskActionSchema>;
export type PortfolioRiskPolicy = z.infer<typeof PortfolioRiskPolicySchema>;
export type CapitalUsageSnapshot = z.infer<typeof CapitalUsageSnapshotSchema>;
export type PortfolioRiskStateSnapshot = z.infer<
  typeof PortfolioRiskStateSnapshotSchema
>;
export type PortfolioRiskEvaluationInput = z.infer<
  typeof PortfolioRiskEvaluationInputSchema
>;
export type PortfolioRiskEvaluationResult = z.infer<
  typeof PortfolioRiskEvaluationResultSchema
>;

const RISK_REDUCING_ACTIONS = new Set<PortfolioRiskAction>([
  "CLOSE",
  "CLAIM_FEES",
  "PARTIAL_CLOSE",
  "RECONCILE_ONLY",
]);

function uniqueTokenMints(tokenMints: string[]): string[] {
  return [...new Set(tokenMints)];
}

function getPositionExposureTokenMints(position: z.infer<typeof PositionSchema>): string[] {
  return uniqueTokenMints([
    position.tokenXMint,
    position.tokenYMint,
    position.baseMint,
    position.quoteMint,
  ]);
}

function toPercent(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }

  return (numerator / denominator) * 100;
}

export function calculateCapitalUsage(input: {
  walletBalance: number;
  reservedBalance: number;
  availableBalance: number;
  allocationDeltaUsd?: number;
}): CapitalUsageSnapshot {
  const walletBalance = Math.max(input.walletBalance, 0);
  const reservedBalance = Math.max(input.reservedBalance, 0);
  const availableBalance = Math.max(input.availableBalance, 0);
  const allocationDeltaUsd = input.allocationDeltaUsd ?? 0;

  const committedCapitalUsd = Math.max(
    walletBalance - reservedBalance - availableBalance,
    0,
  );
  const deployableCapitalUsd = availableBalance;
  const projectedCommittedCapitalUsd = Math.max(
    committedCapitalUsd + allocationDeltaUsd,
    0,
  );
  const freeBalanceAfterAllocationUsd = availableBalance - allocationDeltaUsd;
  const currentCapitalUsagePct = toPercent(committedCapitalUsd, walletBalance);
  const projectedCapitalUsagePct = toPercent(
    projectedCommittedCapitalUsd,
    walletBalance,
  );

  return CapitalUsageSnapshotSchema.parse({
    committedCapitalUsd,
    deployableCapitalUsd,
    freeBalanceAfterAllocationUsd,
    currentCapitalUsagePct,
    projectedCapitalUsagePct,
  });
}

export function calculateDailyLossPct(portfolio: PortfolioState): number {
  const normalizedPortfolio = PortfolioStateSchema.parse(portfolio);
  const realizedLossUsd = Math.max(-normalizedPortfolio.dailyRealizedPnl, 0);

  return Math.max(
    0,
    toPercent(realizedLossUsd, normalizedPortfolio.walletBalance),
  );
}

export function deriveDrawdownState(input: {
  dailyLossPct: number;
  dailyLossLimitPct: number;
}): PortfolioState["drawdownState"] {
  const dailyLossPct = Math.max(input.dailyLossPct, 0);
  const dailyLossLimitPct = Math.max(input.dailyLossLimitPct, 0);

  if (dailyLossPct >= dailyLossLimitPct) {
    return DrawdownStateSchema.parse("LIMIT_REACHED");
  }

  if (dailyLossPct >= dailyLossLimitPct * 0.5) {
    return DrawdownStateSchema.parse("WARNING");
  }

  return DrawdownStateSchema.parse("NORMAL");
}

export function deriveCircuitBreakerState(input: {
  portfolio: PortfolioState;
  policy: PortfolioRiskPolicy;
}): PortfolioState["circuitBreakerState"] {
  const portfolio = PortfolioStateSchema.parse(input.portfolio);
  const policy = PortfolioRiskPolicySchema.parse(input.policy);
  const dailyLossPct = calculateDailyLossPct(portfolio);

  if (dailyLossPct >= policy.dailyLossLimitPct) {
    return CircuitBreakerStateSchema.parse("ON");
  }

  if (portfolio.circuitBreakerState === "ON") {
    return CircuitBreakerStateSchema.parse("ON");
  }

  if (portfolio.circuitBreakerState === "COOLDOWN") {
    return CircuitBreakerStateSchema.parse("COOLDOWN");
  }

  return CircuitBreakerStateSchema.parse("OFF");
}

export function buildPortfolioRiskStateSnapshot(input: {
  portfolio: PortfolioState;
  policy: PortfolioRiskPolicy;
  allocationDeltaUsd?: number;
  solPriceUsd?: number;
}): PortfolioRiskStateSnapshot {
  const portfolio = PortfolioStateSchema.parse(input.portfolio);
  const policy = PortfolioRiskPolicySchema.parse(input.policy);
  const dailyLossPct = calculateDailyLossPct(portfolio);
  const resolvedSolPriceUsd = input.solPriceUsd ?? portfolio.solPriceUsd ?? null;
  const dailyLossSol =
    resolvedSolPriceUsd === null || resolvedSolPriceUsd <= 0
      ? 0
      : Math.max(-portfolio.dailyRealizedPnl, 0) / resolvedSolPriceUsd;

  return PortfolioRiskStateSnapshotSchema.parse({
    dailyLossPct,
    dailyLossSol,
    drawdownState: deriveDrawdownState({
      dailyLossPct,
      dailyLossLimitPct: policy.dailyLossLimitPct,
    }),
    circuitBreakerState: deriveCircuitBreakerState({
      portfolio,
      policy,
    }),
    capitalUsage: calculateCapitalUsage({
      walletBalance: portfolio.walletBalance,
      reservedBalance: portfolio.reservedBalance,
      availableBalance: portfolio.availableBalance,
      ...(input.allocationDeltaUsd === undefined
        ? {}
        : { allocationDeltaUsd: input.allocationDeltaUsd }),
    }),
  });
}

export function projectExposureByPool(input: {
  portfolio: PortfolioState;
  walletBalance: number;
  poolAddress: string | null;
  additionalAllocationUsd?: number;
  releasedPoolAddress?: string | null;
  releasedAllocationUsd?: number;
}): Record<string, number> {
  const portfolio = PortfolioStateSchema.parse(input.portfolio);
  const nextExposureByPool = { ...portfolio.exposureByPool };
  const releasedAllocationPct = toPercent(
    Math.max(input.releasedAllocationUsd ?? 0, 0),
    Math.max(input.walletBalance, 0),
  );

  if (input.releasedPoolAddress !== undefined && input.releasedPoolAddress !== null) {
    nextExposureByPool[input.releasedPoolAddress] = Math.max(
      (nextExposureByPool[input.releasedPoolAddress] ?? 0) - releasedAllocationPct,
      0,
    );
  }

  if (input.poolAddress === null) {
    return nextExposureByPool;
  }

  const incrementalPct = toPercent(
    Math.max(input.additionalAllocationUsd ?? 0, 0),
    Math.max(input.walletBalance, 0),
  );
  nextExposureByPool[input.poolAddress] =
    (nextExposureByPool[input.poolAddress] ?? 0) + incrementalPct;

  return z.record(z.string(), z.number().nonnegative()).parse(nextExposureByPool);
}

export function projectExposureByToken(input: {
  portfolio: PortfolioState;
  walletBalance: number;
  tokenMints: string[];
  additionalAllocationUsd?: number;
  releasedTokenMints?: string[];
  releasedAllocationUsd?: number;
}): Record<string, number> {
  const portfolio = PortfolioStateSchema.parse(input.portfolio);
  const nextExposureByToken = { ...portfolio.exposureByToken };
  const releasedAllocationPct = toPercent(
    Math.max(input.releasedAllocationUsd ?? 0, 0),
    Math.max(input.walletBalance, 0),
  );
  const releasedTokenMints = new Set(uniqueTokenMints(input.releasedTokenMints ?? []));

  for (const tokenMint of releasedTokenMints) {
    nextExposureByToken[tokenMint] = Math.max(
      (nextExposureByToken[tokenMint] ?? 0) - releasedAllocationPct,
      0,
    );
  }

  const incrementalPct = toPercent(
    Math.max(input.additionalAllocationUsd ?? 0, 0),
    Math.max(input.walletBalance, 0),
  );

  for (const tokenMint of uniqueTokenMints(input.tokenMints)) {
    nextExposureByToken[tokenMint] =
      (nextExposureByToken[tokenMint] ?? 0) + incrementalPct;
  }

  return z
    .record(z.string(), z.number().nonnegative())
    .parse(nextExposureByToken);
}

export function updatePortfolioDailyRiskState(input: {
  portfolio: PortfolioState;
  policy: PortfolioRiskPolicy;
  realizedPnlDelta: number;
}): PortfolioState {
  const portfolio = PortfolioStateSchema.parse(input.portfolio);
  const policy = PortfolioRiskPolicySchema.parse(input.policy);
  const nextDailyRealizedPnl = portfolio.dailyRealizedPnl + input.realizedPnlDelta;
  const dailyLossPct = Math.max(
    0,
    toPercent(Math.max(-nextDailyRealizedPnl, 0), portfolio.walletBalance),
  );
  const drawdownState = deriveDrawdownState({
    dailyLossPct,
    dailyLossLimitPct: policy.dailyLossLimitPct,
  });
  const circuitBreakerState =
    dailyLossPct >= policy.dailyLossLimitPct
      ? "ON"
      : portfolio.circuitBreakerState === "COOLDOWN"
        ? "COOLDOWN"
        : "OFF";

  return PortfolioStateSchema.parse({
    ...portfolio,
    dailyRealizedPnl: nextDailyRealizedPnl,
    drawdownState,
    circuitBreakerState,
  });
}

export function evaluatePortfolioRisk(
  rawInput: PortfolioRiskEvaluationInput,
): PortfolioRiskEvaluationResult {
  const input = PortfolioRiskEvaluationInputSchema.parse(rawInput);
  const releasedAllocationUsd =
    input.action === "REBALANCE" && input.position !== null
      ? input.position.currentValueUsd
      : 0;
  const allocationDeltaUsd =
    input.action === "DEPLOY"
      ? input.proposedAllocationUsd
      : input.action === "REBALANCE"
        ? input.proposedAllocationUsd - releasedAllocationUsd
        : 0;
  const state = buildPortfolioRiskStateSnapshot({
    portfolio: input.portfolio,
    policy: input.policy,
    allocationDeltaUsd,
    ...(input.solPriceUsd === undefined ? {} : { solPriceUsd: input.solPriceUsd }),
  });
  const projectedExposureByPool = projectExposureByPool({
    portfolio: input.portfolio,
    walletBalance: input.portfolio.walletBalance,
    poolAddress: input.proposedPoolAddress,
    additionalAllocationUsd:
      input.action === "DEPLOY" || input.action === "REBALANCE"
        ? input.proposedAllocationUsd
        : 0,
    ...(input.action === "REBALANCE" && input.position !== null
      ? {
          releasedPoolAddress: input.position.poolAddress,
          releasedAllocationUsd,
        }
      : {}),
  });
  const projectedExposureByToken = projectExposureByToken({
    portfolio: input.portfolio,
    walletBalance: input.portfolio.walletBalance,
    tokenMints:
      input.action === "DEPLOY" || input.action === "REBALANCE"
        ? input.proposedTokenMints
        : [],
    additionalAllocationUsd:
      input.action === "DEPLOY" || input.action === "REBALANCE"
        ? input.proposedAllocationUsd
        : 0,
    ...(input.action === "REBALANCE" && input.position !== null
      ? {
          releasedTokenMints: getPositionExposureTokenMints(input.position),
          releasedAllocationUsd,
        }
      : {}),
  });

  const blockingRules: string[] = [];

  if (RISK_REDUCING_ACTIONS.has(input.action)) {
    return PortfolioRiskEvaluationResultSchema.parse({
      action: input.action,
      allowed: true,
      decision: "ALLOW",
      reason: "Risk-reducing action remains allowed under global portfolio guardrails",
      blockingRules,
      state,
      projectedExposureByToken,
      projectedExposureByPool,
    });
  }

  if (state.circuitBreakerState !== "OFF") {
    blockingRules.push(
      `circuit breaker is ${state.circuitBreakerState.toLowerCase()}`,
    );
  }

  if (state.dailyLossPct >= input.policy.dailyLossLimitPct) {
    blockingRules.push(
      `daily realized loss reached ${state.dailyLossPct.toFixed(2)}%`,
    );
  }

  if (
    input.policy.maxDailyLossSol !== undefined &&
    state.dailyLossSol >= input.policy.maxDailyLossSol
  ) {
    blockingRules.push(
      `daily realized loss reached ${state.dailyLossSol.toFixed(4)} SOL`,
    );
  }

  if (input.portfolio.pendingActions >= 1) {
    blockingRules.push("wallet already has an active write action");
  }

  if (
    input.action === "DEPLOY" &&
    input.portfolio.openPositions >= input.policy.maxConcurrentPositions
  ) {
    blockingRules.push("max concurrent positions reached");
  }

  if (
    state.capitalUsage.projectedCapitalUsagePct >=
    input.policy.maxCapitalUsagePct
  ) {
    blockingRules.push(
      `projected capital usage reaches or exceeds ${input.policy.maxCapitalUsagePct}%`,
    );
  }

  if (input.portfolio.reservedBalance < input.policy.minReserveUsd) {
    blockingRules.push("minimum reserve balance would be breached");
  }

  if (state.capitalUsage.freeBalanceAfterAllocationUsd < 0) {
    blockingRules.push("available balance would be exceeded");
  }

  if (
    input.action === "REBALANCE" &&
    input.position !== null &&
    input.position.rebalanceCount >= input.policy.maxRebalancesPerPosition
  ) {
    blockingRules.push("max rebalances per position reached");
  }

  if (
    input.action === "DEPLOY" &&
    input.recentNewDeploys >= input.policy.maxNewDeploysPerHour
  ) {
    blockingRules.push("max new deploys per hour reached");
  }

  if (
    input.proposedPoolAddress !== null &&
    (projectedExposureByPool[input.proposedPoolAddress] ?? 0) >=
      input.policy.maxPoolExposurePct
  ) {
    blockingRules.push("projected pool exposure reaches or exceeds maximum");
  }

  for (const tokenMint of input.proposedTokenMints) {
    if (
      (projectedExposureByToken[tokenMint] ?? 0) >=
      input.policy.maxTokenExposurePct
    ) {
      blockingRules.push(
        `projected token exposure reaches or exceeds maximum for ${tokenMint}`,
      );
    }
  }

  const allowed = blockingRules.length === 0;

  return PortfolioRiskEvaluationResultSchema.parse({
    action: input.action,
    allowed,
    decision: allowed ? "ALLOW" : "BLOCK",
    reason: allowed
      ? "Portfolio risk guardrails allow this action"
      : blockingRules[0] ?? "Portfolio risk guardrail blocked this action",
    blockingRules,
    state,
    projectedExposureByToken,
    projectedExposureByPool,
  });
}
