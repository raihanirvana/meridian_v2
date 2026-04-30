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
import { buildPerformanceRecordFromClosedPosition } from "../../domain/rules/performanceRecordRules.js";
import type { Action } from "../../domain/entities/Action.js";
import { logger } from "../../infra/logging/logger.js";

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

  if (normalized.includes("rebalance")) {
    return "rebalance";
  }

  if (normalized.includes("operator")) {
    return "operator";
  }

  return "manual";
}

function normalizeCloseReasonDetail(reason: string): string | undefined {
  const normalized = reason.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return undefined;
  }

  const mapped = mapCloseReason(reason).replaceAll("_", " ");
  if (normalized.toLowerCase() === mapped) {
    return undefined;
  }

  return normalized.slice(0, 300);
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

function resolveClosePerformanceValues(input: {
  position: Position;
  snapshotPosition: Position;
}): {
  finalValueUsd: number;
  pnlUsd: number;
  pnlPct: number;
} {
  const pnlUsd =
    input.snapshotPosition.realizedPnlUsd !== 0
      ? input.snapshotPosition.realizedPnlUsd
      : input.position.realizedPnlUsd !== 0
        ? input.position.realizedPnlUsd
        : input.snapshotPosition.unrealizedPnlUsd;
  const snapshotUsesUnrealizedPnl =
    input.snapshotPosition.realizedPnlUsd === 0 &&
    pnlUsd !== 0 &&
    input.snapshotPosition.unrealizedPnlUsd !== 0;
  const finalValueUsd = Math.max(
    input.snapshotPosition.currentValueUsd +
      input.snapshotPosition.feesClaimedUsd +
      (snapshotUsesUnrealizedPnl ? 0 : pnlUsd),
    0,
  );
  const initialValueUsd = Math.max(finalValueUsd - pnlUsd, 0);

  return {
    finalValueUsd,
    pnlUsd,
    pnlPct: initialValueUsd <= 0 ? 0 : (pnlUsd / initialValueUsd) * 100,
  };
}

export function buildPerformanceRecordFromClose(input: {
  position: Position;
  performanceSnapshotPosition?: Position;
  closedAction?: Action;
  reason: string;
  now: string;
}): PerformanceRecord {
  const snapshotPosition = input.performanceSnapshotPosition ?? input.position;
  const entryMetadata = {
    ...resolveEntryMetadata(snapshotPosition),
    ...resolveEntryMetadata(input.position),
  } satisfies PositionEntryMetadata;
  const minutesHeld = diffMinutes(
    snapshotPosition.openedAt,
    input.position.closedAt ?? input.now,
  );
  const minutesOutOfRange = diffMinutes(
    snapshotPosition.outOfRangeSince,
    input.position.closedAt ?? input.now,
  );
  const minutesInRange = Math.max(minutesHeld - minutesOutOfRange, 0);
  const performanceValues = resolveClosePerformanceValues({
    position: input.position,
    snapshotPosition,
  });
  const closeReasonDetail = normalizeCloseReasonDetail(input.reason);

  const result = buildPerformanceRecordFromClosedPosition({
    position: {
      ...input.position,
      entryMetadata,
      openedAt: snapshotPosition.openedAt ?? input.position.openedAt,
      currentValueUsd: snapshotPosition.currentValueUsd,
      feesClaimedUsd: snapshotPosition.feesClaimedUsd,
      realizedPnlUsd: performanceValues.pnlUsd,
      outOfRangeSince: snapshotPosition.outOfRangeSince,
    },
    closedAction:
      input.closedAction ??
      ({
        actionId: "unknown_close_action",
        type: "CLOSE",
        status: "DONE",
        wallet: input.position.wallet,
        positionId: input.position.positionId,
        idempotencyKey: "unknown_close_action",
        requestPayload: {},
        resultPayload: null,
        txIds: [],
        error: null,
        requestedAt: snapshotPosition.openedAt ?? input.now,
        startedAt: input.now,
        completedAt: input.position.closedAt ?? input.now,
        requestedBy: "system",
      } satisfies Action),
    closeReason: mapCloseReason(input.reason),
    ...(closeReasonDetail === undefined ? {} : { closeReasonDetail }),
    finalValueUsd: performanceValues.finalValueUsd,
    feesEarnedUsd: snapshotPosition.feesClaimedUsd,
    pnlUsd: performanceValues.pnlUsd,
    pnlPct: performanceValues.pnlPct,
    minutesHeld,
    minutesInRange,
    recordedAt: input.now,
  });

  if (result.skipped) {
    throw new Error(`Performance record build skipped: ${result.reason}`);
  }

  return result.record;
}

export function createRecordPositionPerformanceLessonHook(
  input: CreateRecordPositionPerformanceLessonHookInput,
) {
  const idGen = input.idGen ?? createUlid;

  return async (hookInput: {
    position: Position;
    performanceSnapshotPosition?: Position;
    reason: string;
    closedAction: Action;
    now: string;
  }): Promise<PerformanceRecord | void> => {
    const snapshotPosition =
      hookInput.performanceSnapshotPosition ?? hookInput.position;
    const performanceValues = resolveClosePerformanceValues({
      position: hookInput.position,
      snapshotPosition,
    });
    const closeReasonDetail = normalizeCloseReasonDetail(hookInput.reason);
    const buildResult = buildPerformanceRecordFromClosedPosition({
      position: {
        ...snapshotPosition,
        closedAt: hookInput.position.closedAt,
        realizedPnlUsd: performanceValues.pnlUsd,
      },
      closedAction: hookInput.closedAction,
      closeReason: mapCloseReason(hookInput.reason),
      ...(closeReasonDetail === undefined ? {} : { closeReasonDetail }),
      finalValueUsd: performanceValues.finalValueUsd,
      feesEarnedUsd: snapshotPosition.feesClaimedUsd,
      pnlUsd: performanceValues.pnlUsd,
      pnlPct: performanceValues.pnlPct,
      minutesHeld: diffMinutes(
        snapshotPosition.openedAt,
        hookInput.position.closedAt ?? hookInput.now,
      ),
      minutesInRange: Math.max(
        diffMinutes(
          snapshotPosition.openedAt,
          hookInput.position.closedAt ?? hookInput.now,
        ) -
          diffMinutes(
            snapshotPosition.outOfRangeSince,
            hookInput.position.closedAt ?? hookInput.now,
          ),
        0,
      ),
      recordedAt: hookInput.now,
    });

    let performance: PerformanceRecord | null = buildResult.skipped
      ? null
      : buildResult.record;

    if (buildResult.skipped) {
      performance =
        (await input.performanceRepository.list()).find(
          (record) => record.positionId === hookInput.position.positionId,
        ) ?? null;
    }

    if (buildResult.skipped && performance === null) {
      try {
        await input.journalRepository?.append({
          timestamp: hookInput.now,
          eventType: "PERFORMANCE_RECORD_SKIPPED",
          actor: "system",
          wallet: hookInput.position.wallet,
          positionId: hookInput.position.positionId,
          actionId: hookInput.closedAction.actionId,
          before: null,
          after: {
            reason: buildResult.reason,
            pool: hookInput.position.poolAddress,
          },
          txIds: [],
          resultStatus: "SKIPPED",
          error: buildResult.reason,
        });
      } catch (error) {
        logger.warn(
          { err: error, positionId: hookInput.position.positionId },
          "performance skipped journal append failed",
        );
      }
      return;
    }
    if (performance === null) {
      return;
    }

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
          positionId: result.performance.positionId,
          sourceActionId: hookInput.closedAction.actionId,
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

    if (input.signalWeightsStore !== undefined && result.skipped !== true) {
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
