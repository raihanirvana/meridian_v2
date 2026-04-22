import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { RuntimePolicyStore } from "../../adapters/config/RuntimePolicyStore.js";
import { type LessonRepositoryInterface } from "../../adapters/storage/LessonRepository.js";
import { type PerformanceRepositoryInterface } from "../../adapters/storage/PerformanceRepository.js";
import { type PoolMemoryRepository } from "../../adapters/storage/PoolMemoryRepository.js";
import { type SignalWeightsStore } from "../../adapters/storage/SignalWeightsStore.js";
import { type PerformanceRecord } from "../../domain/entities/PerformanceRecord.js";
import {
  type Position,
  type PositionEntryMetadata,
} from "../../domain/entities/Position.js";
import { createUlid } from "../../infra/id/createUlid.js";

import { recordPositionPerformance } from "../usecases/recordPositionPerformance.js";
import { recordPoolDeploy } from "../usecases/recordPoolDeploy.js";
import { maybeRecalibrateSignalWeights } from "../usecases/maybeRecalibrateSignalWeights.js";
import { maybeEvolvePolicy } from "../usecases/maybeEvolvePolicy.js";

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
  poolMemoryRepository?: PoolMemoryRepository;
  runtimePolicyStore?: RuntimePolicyStore;
  signalWeightsStore?: SignalWeightsStore;
  darwinEnabled?: boolean;
  journalRepository?: JournalRepository;
  idGen?: () => string;
}

function resolveEntryMetadata(position: Position): PositionEntryMetadata {
  return position.entryMetadata ?? {};
}

export function buildPerformanceRecordFromClose(input: {
  position: Position;
  performanceSnapshotPosition?: Position;
  reason: string;
  now: string;
}): PerformanceRecord {
  const snapshotPosition = input.performanceSnapshotPosition ?? input.position;
  const entryMetadata = resolveEntryMetadata(input.position);
  const minutesHeld = diffMinutes(snapshotPosition.openedAt, input.position.closedAt ?? input.now);
  const minutesOutOfRange = diffMinutes(
    snapshotPosition.outOfRangeSince,
    input.position.closedAt ?? input.now,
  );
  const minutesInRange = Math.max(minutesHeld - minutesOutOfRange, 0);
  const rangeEfficiencyPct =
    minutesHeld === 0 ? 100 : Math.min((minutesInRange / minutesHeld) * 100, 100);
  const recoveredFinalValueUsd = Math.max(
    snapshotPosition.currentValueUsd +
      snapshotPosition.realizedPnlUsd +
      snapshotPosition.feesClaimedUsd,
    0,
  );
  const recoveredInitialValueUsd = Math.max(
    recoveredFinalValueUsd - snapshotPosition.realizedPnlUsd,
    0,
  );

  return {
    positionId: input.position.positionId,
    wallet: input.position.wallet,
    pool: input.position.poolAddress,
    poolName: entryMetadata.poolName ?? input.position.poolAddress,
    baseMint: input.position.baseMint,
    strategy: input.position.strategy === "spot" || input.position.strategy === "curve"
      ? input.position.strategy
      : "bid_ask",
    binStep: entryMetadata.binStep ?? 0,
    binRangeLower: input.position.rangeLowerBin,
    binRangeUpper: input.position.rangeUpperBin,
    volatility: entryMetadata.volatility ?? 0,
    feeTvlRatio: entryMetadata.feeTvlRatio ?? 0,
    organicScore: entryMetadata.organicScore ?? 0,
    amountSol: entryMetadata.amountSol ?? 0,
    initialValueUsd: recoveredInitialValueUsd,
    finalValueUsd: recoveredFinalValueUsd,
    feesEarnedUsd: snapshotPosition.feesClaimedUsd,
    pnlUsd: snapshotPosition.realizedPnlUsd,
    pnlPct:
      recoveredInitialValueUsd <= 0
        ? 0
        : (snapshotPosition.realizedPnlUsd / recoveredInitialValueUsd) * 100,
    rangeEfficiencyPct,
    minutesHeld,
    minutesInRange,
    closeReason: mapCloseReason(input.reason),
    deployedAt: snapshotPosition.openedAt ?? input.now,
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
    performanceSnapshotPosition?: Position;
    reason: string;
    now: string;
  }): Promise<PerformanceRecord | void> => {
    const performance = buildPerformanceRecordFromClose({
      position: hookInput.position,
      ...(hookInput.performanceSnapshotPosition === undefined
        ? {}
        : { performanceSnapshotPosition: hookInput.performanceSnapshotPosition }),
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

    if (
      input.poolMemoryRepository !== undefined &&
      result.skipped !== true &&
      result.performance !== undefined
    ) {
      await recordPoolDeploy({
        poolMemoryRepository: input.poolMemoryRepository,
        ...(input.journalRepository === undefined
          ? {}
          : { journalRepository: input.journalRepository }),
        poolAddress: result.performance.pool,
        name: result.performance.poolName,
        baseMint: result.performance.baseMint,
        deploy: {
          deployedAt: result.performance.deployedAt,
          closedAt: result.performance.closedAt,
          pnlPct: result.performance.pnlPct,
          pnlUsd: result.performance.pnlUsd,
          rangeEfficiencyPct: result.performance.rangeEfficiencyPct,
          minutesHeld: result.performance.minutesHeld,
          closeReason: result.performance.closeReason,
          strategy: result.performance.strategy,
          volatilityAtDeploy: result.performance.volatility,
        },
        now: hookInput.now,
      });
    }

    if (
      input.runtimePolicyStore !== undefined &&
      result.skipped !== true &&
      result.performance !== undefined
    ) {
      await maybeEvolvePolicy({
        performanceRepository: input.performanceRepository,
        runtimePolicyStore: input.runtimePolicyStore,
        lessonRepository: input.lessonRepository,
        ...(input.journalRepository === undefined
          ? {}
          : { journalRepository: input.journalRepository }),
        now: () => hookInput.now,
        idGen,
      });
    }

    if (
      input.signalWeightsStore !== undefined &&
      result.skipped !== true
    ) {
      await maybeRecalibrateSignalWeights({
        performanceRepository: input.performanceRepository,
        signalWeightsStore: input.signalWeightsStore,
        lessonRepository: input.lessonRepository,
        ...(input.journalRepository === undefined
          ? {}
          : { journalRepository: input.journalRepository }),
        darwinEnabled: input.darwinEnabled ?? false,
        now: () => hookInput.now,
        idGen,
      });
    }

    return result.performance;
  };
}
