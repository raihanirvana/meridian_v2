import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import { type LessonRepositoryInterface } from "../../adapters/storage/LessonRepository.js";
import { type PerformanceRepositoryInterface } from "../../adapters/storage/PerformanceRepository.js";
import { type PerformanceRecord } from "../../domain/entities/PerformanceRecord.js";
import { type Position } from "../../domain/entities/Position.js";
import { createUlid } from "../../infra/id/createUlid.js";

import { recordPositionPerformance } from "../usecases/recordPositionPerformance.js";

function diffMinutes(from: string | null, to: string | null): number {
  if (from === null || to === null) {
    return 0;
  }

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    return 0;
  }

  return Math.max(0, Math.floor((toMs - fromMs) / 60_000));
}

function mapCloseReason(reason: string): PerformanceRecord["closeReason"] {
  const normalized = reason.trim().toLowerCase();

  if (normalized.includes("stop loss")) {
    return "stop_loss";
  }

  if (normalized.includes("take profit")) {
    return "take_profit";
  }

  if (normalized.includes("out of range")) {
    return "out_of_range";
  }

  if (normalized.includes("volume")) {
    return "volume_collapse";
  }

  if (normalized.includes("timeout")) {
    return "timeout";
  }

  if (normalized.includes("operator")) {
    return "operator";
  }

  return "manual";
}

export interface CreateRecordPositionPerformanceLessonHookInput {
  lessonRepository: LessonRepositoryInterface;
  performanceRepository: PerformanceRepositoryInterface;
  journalRepository?: JournalRepository;
  idGen?: () => string;
}

export function buildPerformanceRecordFromClose(input: {
  position: Position;
  reason: string;
  now: string;
}): PerformanceRecord {
  const minutesHeld = diffMinutes(input.position.openedAt, input.position.closedAt ?? input.now);
  const minutesOutOfRange = diffMinutes(
    input.position.outOfRangeSince,
    input.position.closedAt ?? input.now,
  );
  const minutesInRange = Math.max(minutesHeld - minutesOutOfRange, 0);
  const rangeEfficiencyPct =
    minutesHeld === 0 ? 100 : Math.min((minutesInRange / minutesHeld) * 100, 100);
  const recoveredFinalValueUsd = Math.max(
    input.position.currentValueUsd +
      input.position.realizedPnlUsd +
      input.position.feesClaimedUsd,
    0,
  );
  const recoveredInitialValueUsd = Math.max(
    recoveredFinalValueUsd - input.position.realizedPnlUsd,
    0,
  );

  return {
    positionId: input.position.positionId,
    wallet: input.position.wallet,
    pool: input.position.poolAddress,
    poolName: input.position.poolAddress,
    baseMint: input.position.baseMint,
    strategy: input.position.strategy === "spot" || input.position.strategy === "curve"
      ? input.position.strategy
      : "bid_ask",
    binStep: 0,
    binRangeLower: input.position.rangeLowerBin,
    binRangeUpper: input.position.rangeUpperBin,
    volatility: 0,
    feeTvlRatio: 0,
    organicScore: 0,
    amountSol: 0,
    initialValueUsd: recoveredInitialValueUsd,
    finalValueUsd: recoveredFinalValueUsd,
    feesEarnedUsd: input.position.feesClaimedUsd,
    pnlUsd: input.position.realizedPnlUsd,
    pnlPct:
      recoveredInitialValueUsd <= 0
        ? 0
        : (input.position.realizedPnlUsd / recoveredInitialValueUsd) * 100,
    rangeEfficiencyPct,
    minutesHeld,
    minutesInRange,
    closeReason: mapCloseReason(input.reason),
    deployedAt: input.position.openedAt ?? input.now,
    closedAt: input.position.closedAt ?? input.now,
    recordedAt: input.now,
  };
}

export function createRecordPositionPerformanceLessonHook(
  input: CreateRecordPositionPerformanceLessonHookInput,
) {
  const idGen = input.idGen ?? createUlid;

  return async (hookInput: {
    position: Position;
    reason: string;
    now: string;
  }): Promise<PerformanceRecord | void> => {
    const performance = buildPerformanceRecordFromClose({
      position: hookInput.position,
      reason: hookInput.reason,
      now: hookInput.now,
    });

    const result = await recordPositionPerformance({
      performance,
      lessonRepository: input.lessonRepository,
      performanceRepository: input.performanceRepository,
      ...(input.journalRepository === undefined
        ? {}
        : { journalRepository: input.journalRepository }),
      idGen,
      now: () => hookInput.now,
    });

    return result.performance;
  };
}
