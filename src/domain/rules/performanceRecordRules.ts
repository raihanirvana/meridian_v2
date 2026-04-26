import { z } from "zod";

import type { Action } from "../entities/Action.js";
import {
  PerformanceRecordSchema,
  type PerformanceRecord,
} from "../entities/PerformanceRecord.js";
import type { Position } from "../entities/Position.js";
import {
  CloseReasonSchema,
  StrategySchema,
  type CloseReason,
} from "../types/enums.js";
import { isSuspiciousUnitMix } from "./lessonRules.js";

export const PerformanceRecordSkippedReasonSchema = z.enum([
  "missing_final_accounting",
  "invalid_cost_basis",
  "suspicious_unit_mix",
]);

export type PerformanceRecordSkippedReason = z.infer<
  typeof PerformanceRecordSkippedReasonSchema
>;

export type PerformanceRecordBuildResult =
  | { skipped: false; record: PerformanceRecord }
  | { skipped: true; reason: PerformanceRecordSkippedReason };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function resolveInitialValueUsd(input: {
  finalValueUsd: number;
  pnlUsd: number;
  position: Position;
}): number | null {
  const fromPnl = input.finalValueUsd - input.pnlUsd;
  if (fromPnl > 0) {
    return fromPnl;
  }

  if (input.position.currentValueUsd > 0) {
    return input.position.currentValueUsd;
  }

  if (
    input.position.deployAmountBase > 0 ||
    input.position.deployAmountQuote > 0
  ) {
    return null;
  }

  return fromPnl;
}

function resolvePoolName(position: Position): string {
  return position.entryMetadata?.poolName ?? position.poolAddress;
}

export function buildPerformanceRecordFromClosedPosition(input: {
  position: Position;
  closedAction: Action;
  closeReason: CloseReason;
  finalValueUsd: number;
  feesEarnedUsd: number;
  pnlUsd: number;
  pnlPct: number;
  minutesHeld: number;
  minutesInRange?: number | undefined;
  recordedAt: string;
}): PerformanceRecordBuildResult {
  const closeReason = CloseReasonSchema.parse(input.closeReason);
  const strategy = StrategySchema.safeParse(input.position.strategy);
  if (!strategy.success) {
    return {
      skipped: true,
      reason: "missing_final_accounting",
    };
  }

  if (
    !isFiniteNumber(input.finalValueUsd) ||
    !isFiniteNumber(input.feesEarnedUsd) ||
    !isFiniteNumber(input.pnlUsd) ||
    !isFiniteNumber(input.pnlPct)
  ) {
    return {
      skipped: true,
      reason: "missing_final_accounting",
    };
  }

  const finalValueUsd = Math.max(input.finalValueUsd, 0);
  const initialValueUsd = resolveInitialValueUsd({
    finalValueUsd,
    pnlUsd: input.pnlUsd,
    position: input.position,
  });

  if (initialValueUsd === null || initialValueUsd <= 0) {
    return {
      skipped: true,
      reason: "invalid_cost_basis",
    };
  }

  const minutesHeld = Math.max(0, Math.floor(input.minutesHeld));
  const rawMinutesInRange = input.minutesInRange ?? minutesHeld;
  const minutesInRange = clamp(Math.floor(rawMinutesInRange), 0, minutesHeld);
  const rangeEfficiencyPct =
    minutesHeld === 0
      ? 100
      : clamp((minutesInRange / minutesHeld) * 100, 0, 100);
  const pnlPct = (input.pnlUsd / initialValueUsd) * 100;
  const entryMetadata = input.position.entryMetadata ?? {};
  const deployedAt = input.position.openedAt ?? input.closedAction.requestedAt;
  const closedAt = input.position.closedAt ?? input.closedAction.completedAt;

  if (closedAt === undefined || closedAt === null) {
    return {
      skipped: true,
      reason: "missing_final_accounting",
    };
  }

  const record = PerformanceRecordSchema.parse({
    positionId: input.position.positionId,
    wallet: input.position.wallet,
    pool: input.position.poolAddress,
    poolName: resolvePoolName(input.position),
    baseMint: input.position.baseMint,
    strategy: strategy.data,
    binStep: entryMetadata.binStep ?? 0,
    binRangeLower: input.position.rangeLowerBin,
    binRangeUpper: input.position.rangeUpperBin,
    volatility: entryMetadata.volatility ?? 0,
    feeTvlRatio: entryMetadata.feeTvlRatio ?? 0,
    organicScore: entryMetadata.organicScore ?? 0,
    amountSol: entryMetadata.amountSol ?? 0,
    initialValueUsd,
    finalValueUsd,
    feesEarnedUsd: Math.max(input.feesEarnedUsd, 0),
    pnlUsd: input.pnlUsd,
    pnlPct,
    rangeEfficiencyPct,
    minutesHeld,
    minutesInRange,
    closeReason,
    deployedAt,
    closedAt,
    recordedAt: input.recordedAt,
  });

  if (isSuspiciousUnitMix(record)) {
    return {
      skipped: true,
      reason: "suspicious_unit_mix",
    };
  }

  return {
    skipped: false,
    record,
  };
}
