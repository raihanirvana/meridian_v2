import { z } from "zod";

import { PortfolioStateSchema } from "../entities/PortfolioState.js";
import { PositionSchema } from "../entities/Position.js";
import { ManagementActionSchema } from "../types/enums.js";

import {
  MANAGEMENT_PRIORITY_SCORES,
  ManagementPrioritySchema,
} from "../scoring/managementPriority.js";

const TimestampSchema = z.string().datetime();

export const ManagementSignalsSchema = z
  .object({
    forcedManualClose: z.boolean(),
    severeTokenRisk: z.boolean(),
    liquidityCollapse: z.boolean(),
    severeNegativeYield: z.boolean(),
    claimableFeesUsd: z.number().nonnegative(),
    expectedRebalanceImprovement: z.boolean(),
    dataIncomplete: z.boolean(),
  })
  .strict();

export const BaseManagementPolicySchema = z
  .object({
    stopLossUsd: z.number().nonnegative(),
    maxHoldMinutes: z.number().int().nonnegative(),
    maxOutOfRangeMinutes: z.number().int().nonnegative(),
    trailingTakeProfitEnabled: z.boolean().optional(),
    trailingTriggerPct: z.number().nonnegative().optional(),
    trailingDropPct: z.number().nonnegative().optional(),
    claimFeesThresholdUsd: z.number().nonnegative(),
    partialCloseEnabled: z.boolean(),
    partialCloseProfitTargetUsd: z.number().nonnegative(),
    rebalanceEnabled: z.boolean(),
    maxRebalancesPerPosition: z.number().int().nonnegative(),
  })
  .strict();

export const ManagementPolicySchema = BaseManagementPolicySchema.superRefine(
  (policy, ctx) => {
    if (policy.trailingTakeProfitEnabled !== true) {
      return;
    }

    if ((policy.trailingTriggerPct ?? 0) <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trailingTriggerPct"],
        message:
          "must be greater than zero when trailingTakeProfitEnabled is true",
      });
    }

    if ((policy.trailingDropPct ?? 0) <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trailingDropPct"],
        message:
          "must be greater than zero when trailingTakeProfitEnabled is true",
      });
    }
  },
);

export const ManagementEvaluationInputSchema = z
  .object({
    now: TimestampSchema,
    position: PositionSchema,
    portfolio: PortfolioStateSchema,
    signals: ManagementSignalsSchema,
    policy: ManagementPolicySchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.position.status !== "OPEN") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["position", "status"],
        message: "management engine only accepts OPEN positions",
      });
    }
  });

export const ManagementEvaluationResultSchema = z
  .object({
    action: ManagementActionSchema,
    priority: ManagementPrioritySchema,
    priorityScore: z.number(),
    reason: z.string().min(1),
    triggerReasons: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type ManagementSignals = z.infer<typeof ManagementSignalsSchema>;
export type ManagementPolicy = z.infer<typeof ManagementPolicySchema>;
export type ManagementEvaluationInput = z.infer<
  typeof ManagementEvaluationInputSchema
>;
export type ManagementEvaluationResult = z.infer<
  typeof ManagementEvaluationResultSchema
>;

function elapsedMinutes(from: string | null, now: string): number | null {
  if (from === null) {
    return null;
  }

  const fromMs = Date.parse(from);
  const nowMs = Date.parse(now);
  if (Number.isNaN(fromMs) || Number.isNaN(nowMs)) {
    return null;
  }
  return Math.max(0, Math.floor((nowMs - fromMs) / 60_000));
}

function isRangeInvalid(input: ManagementEvaluationInput): boolean {
  const { activeBin, rangeLowerBin, rangeUpperBin, outOfRangeSince } =
    input.position;

  if (outOfRangeSince !== null) {
    return true;
  }

  if (activeBin === null) {
    return false;
  }

  return activeBin < rangeLowerBin || activeBin > rangeUpperBin;
}

function buildResult(input: {
  action: ManagementEvaluationResult["action"];
  priority: ManagementEvaluationResult["priority"];
  reason: string;
  triggerReasons: string[];
}): ManagementEvaluationResult {
  return ManagementEvaluationResultSchema.parse({
    action: input.action,
    priority: input.priority,
    priorityScore: MANAGEMENT_PRIORITY_SCORES[input.priority],
    reason: input.reason,
    triggerReasons: input.triggerReasons,
  });
}

function trailingTakeProfitTriggered(
  input: ManagementEvaluationInput,
): boolean {
  if (input.policy.trailingTakeProfitEnabled !== true) {
    return false;
  }

  const triggerPct = input.policy.trailingTriggerPct ?? 0;
  const dropPct = input.policy.trailingDropPct ?? 0;
  if (triggerPct <= 0 || dropPct <= 0) {
    return false;
  }

  const estimatedInitialValueUsd = Math.max(
    input.position.currentValueUsd - input.position.unrealizedPnlUsd,
    0,
  );
  if (estimatedInitialValueUsd <= 0) {
    return false;
  }

  const currentPnlPct =
    (input.position.unrealizedPnlUsd / estimatedInitialValueUsd) * 100;
  const peakPnlPct = input.position.peakPnlPct ?? currentPnlPct;

  if (peakPnlPct < triggerPct) {
    return false;
  }

  return currentPnlPct <= peakPnlPct - dropPct;
}

export function evaluateManagementAction(
  rawInput: ManagementEvaluationInput,
): ManagementEvaluationResult {
  const input = ManagementEvaluationInputSchema.parse(rawInput);

  const emergencyReasons: string[] = [];
  if (input.portfolio.circuitBreakerState !== "OFF") {
    emergencyReasons.push(
      `circuit breaker is ${input.portfolio.circuitBreakerState.toLowerCase()}`,
    );
  }
  if (input.signals.severeTokenRisk) {
    emergencyReasons.push("severe token risk detected");
  }
  if (input.signals.liquidityCollapse) {
    emergencyReasons.push("liquidity collapse detected");
  }
  if (input.signals.forcedManualClose) {
    emergencyReasons.push("forced manual close requested");
  }
  if (emergencyReasons.length > 0) {
    return buildResult({
      action: "CLOSE",
      priority: "EMERGENCY",
      reason: "Emergency rule triggered close",
      triggerReasons: emergencyReasons,
    });
  }

  const hardExitReasons: string[] = [];
  if (
    input.policy.stopLossUsd > 0 &&
    input.position.unrealizedPnlUsd <= -input.policy.stopLossUsd
  ) {
    hardExitReasons.push(
      `stop loss reached at ${input.position.unrealizedPnlUsd.toFixed(2)} USD`,
    );
  }

  const heldMinutes = elapsedMinutes(input.position.openedAt, input.now);
  if (
    heldMinutes !== null &&
    input.policy.maxHoldMinutes > 0 &&
    heldMinutes >= input.policy.maxHoldMinutes
  ) {
    hardExitReasons.push(`max hold time reached at ${heldMinutes} minutes`);
  }

  const outOfRangeMinutes = elapsedMinutes(
    input.position.outOfRangeSince,
    input.now,
  );
  if (
    outOfRangeMinutes !== null &&
    input.policy.maxOutOfRangeMinutes > 0 &&
    outOfRangeMinutes >= input.policy.maxOutOfRangeMinutes
  ) {
    hardExitReasons.push(
      `position out of range for ${outOfRangeMinutes} minutes`,
    );
  }

  if (input.signals.severeNegativeYield) {
    hardExitReasons.push("severe negative yield condition detected");
  }

  if (hardExitReasons.length > 0) {
    return buildResult({
      action: "CLOSE",
      priority: "HARD_EXIT",
      reason: "Hard exit rule triggered close",
      triggerReasons: hardExitReasons,
    });
  }

  if (input.position.needsReconciliation || input.signals.dataIncomplete) {
    return buildResult({
      action: "RECONCILE_ONLY",
      priority: "RECONCILE_ONLY",
      reason: "Position requires reconciliation before further management",
      triggerReasons: input.position.needsReconciliation
        ? ["position.needsReconciliation is true"]
        : ["management snapshot is incomplete"],
    });
  }

  if (trailingTakeProfitTriggered(input)) {
    const estimatedInitialValueUsd = Math.max(
      input.position.currentValueUsd - input.position.unrealizedPnlUsd,
      0,
    );
    const currentPnlPct =
      estimatedInitialValueUsd <= 0
        ? 0
        : (input.position.unrealizedPnlUsd / estimatedInitialValueUsd) * 100;
    const peakPnlPct = input.position.peakPnlPct ?? currentPnlPct;
    return buildResult({
      action: "CLOSE",
      priority: "HARD_EXIT",
      reason: "Trailing take profit exit triggered",
      triggerReasons: [
        `peak pnl reached ${peakPnlPct.toFixed(2)}%`,
        `current pnl retraced to ${currentPnlPct.toFixed(2)}%`,
      ],
    });
  }

  if (
    input.policy.claimFeesThresholdUsd > 0 &&
    input.signals.claimableFeesUsd >= input.policy.claimFeesThresholdUsd
  ) {
    return buildResult({
      action: "CLAIM_FEES",
      priority: "MAINTENANCE_CLAIM_FEES",
      reason: "Claim fees threshold reached",
      triggerReasons: [
        `claimable fees reached ${input.signals.claimableFeesUsd.toFixed(2)} USD`,
      ],
    });
  }

  if (
    input.policy.partialCloseEnabled &&
    input.policy.partialCloseProfitTargetUsd > 0 &&
    input.position.unrealizedPnlUsd >= input.policy.partialCloseProfitTargetUsd
  ) {
    return buildResult({
      action: "PARTIAL_CLOSE",
      priority: "MAINTENANCE_PARTIAL_CLOSE",
      reason: "Partial close profit target reached",
      triggerReasons: [
        `unrealized pnl reached ${input.position.unrealizedPnlUsd.toFixed(2)} USD`,
      ],
    });
  }

  if (
    input.policy.rebalanceEnabled &&
    isRangeInvalid(input) &&
    input.position.rebalanceCount < input.policy.maxRebalancesPerPosition &&
    input.signals.expectedRebalanceImprovement
  ) {
    return buildResult({
      action: "REBALANCE",
      priority: "MAINTENANCE_REBALANCE",
      reason: "Range invalid and rebalance is expected to improve outcome",
      triggerReasons: [
        "position range is invalid",
        "rebalance improvement expected",
      ],
    });
  }

  return buildResult({
    action: "HOLD",
    priority: "HOLD",
    reason: "No higher-priority management rule triggered",
    triggerReasons: ["all management checks are currently safe"],
  });
}
