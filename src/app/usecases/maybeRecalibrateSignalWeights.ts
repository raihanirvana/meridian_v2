import type { JournalRepository } from "../../adapters/storage/JournalRepository.js";
import type { LessonRepositoryInterface } from "../../adapters/storage/LessonRepository.js";
import type { PerformanceRepositoryInterface } from "../../adapters/storage/PerformanceRepository.js";
import type { SignalWeightsStore } from "../../adapters/storage/SignalWeightsStore.js";
import { LessonSchema } from "../../domain/entities/Lesson.js";
import {
  SignalWeightsSchema,
  type SignalWeights,
} from "../../domain/entities/SignalWeights.js";
import {
  MIN_SIGNAL_WEIGHT_SAMPLES,
  recalculateWeights,
} from "../../domain/rules/signalWeightRules.js";
import { logger } from "../../infra/logging/logger.js";

export const MIN_SIGNAL_RECALIBRATION_POSITIONS = 10;

export interface MaybeRecalibrateSignalWeightsInput {
  performanceRepository: PerformanceRepositoryInterface;
  signalWeightsStore: SignalWeightsStore;
  lessonRepository: LessonRepositoryInterface;
  journalRepository?: JournalRepository;
  darwinEnabled: boolean;
  now: () => string;
  idGen: () => string;
}

export type MaybeRecalibrateSignalWeightsResult =
  | {
      skipped: true;
      reason:
        | "flag_disabled"
        | "position_count_gate"
        | "already_recalibrated_for_position_count";
    }
  | {
      skipped?: false;
      positionsAtRecalibration: number;
      changes: Partial<SignalWeights>;
      rationale: Record<string, string>;
    };

function formatDarwinRule(input: {
  positionsAtRecalibration: number;
  changes: Record<string, unknown>;
  rationale: Record<string, string>;
}): string {
  const changeText = Object.entries(input.changes)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
  const rationaleText = Object.values(input.rationale).join("; ");

  return `[AUTO-DARWIN @ ${input.positionsAtRecalibration} positions] ${changeText}${
    rationaleText.length === 0 ? "" : ` — ${rationaleText}`
  }`;
}

export async function maybeRecalibrateSignalWeights(
  input: MaybeRecalibrateSignalWeightsInput,
): Promise<MaybeRecalibrateSignalWeightsResult> {
  if (!input.darwinEnabled) {
    return {
      skipped: true,
      reason: "flag_disabled",
    };
  }

  const performance = await input.performanceRepository.list();
  const positionsAtRecalibration = performance.length;
  if (
    positionsAtRecalibration < MIN_SIGNAL_RECALIBRATION_POSITIONS ||
    positionsAtRecalibration % MIN_SIGNAL_RECALIBRATION_POSITIONS !== 0
  ) {
    return {
      skipped: true,
      reason: "position_count_gate",
    };
  }

  const currentSnapshot = await input.signalWeightsStore.snapshot();
  if (
    currentSnapshot.metadata.positionsAtRecalibration ===
    positionsAtRecalibration
  ) {
    return {
      skipped: true,
      reason: "already_recalibrated_for_position_count",
    };
  }

  const currentWeights = currentSnapshot.weights;
  const recalculated = recalculateWeights({
    performance,
    currentWeights,
  });

  if (Object.keys(recalculated.changes).length === 0) {
    const noopNow = input.now();
    await input.signalWeightsStore.replace(currentWeights, {
      lastRecalibratedAt: noopNow,
      positionsAtRecalibration,
    });
    try {
      await input.journalRepository?.append({
        timestamp: noopNow,
        eventType: "SIGNAL_WEIGHTS_RECALIBRATION_NOOP",
        actor: "system",
        wallet: "system",
        positionId: null,
        actionId: null,
        before: null,
        after: { positionsAtRecalibration, rationale: recalculated.rationale },
        txIds: [],
        resultStatus: "UNCHANGED",
        error: null,
      });
    } catch (error) {
      logger.warn(
        { err: error, positionsAtRecalibration },
        "signal weights recalibration noop journal append failed",
      );
    }
    return {
      positionsAtRecalibration,
      changes: {},
      rationale: recalculated.rationale,
    };
  }

  const now = input.now();
  const nextWeights = SignalWeightsSchema.parse({
    ...currentWeights,
    ...Object.fromEntries(
      Object.entries(recalculated.changes).map(([key, value]) => [
        key,
        {
          ...value,
          sampleSize: Math.max(
            value?.sampleSize ?? 0,
            MIN_SIGNAL_WEIGHT_SAMPLES,
          ),
          lastAdjustedAt: now,
        },
      ]),
    ),
  });

  await input.signalWeightsStore.replace(nextWeights, {
    lastRecalibratedAt: now,
    positionsAtRecalibration,
  });

  try {
    await input.journalRepository?.append({
      timestamp: now,
      eventType: "SIGNAL_WEIGHTS_RECALIBRATED",
      actor: "system",
      wallet: "system",
      positionId: null,
      actionId: null,
      before: null,
      after: {
        changes: recalculated.changes,
        rationale: recalculated.rationale,
        positionsAtRecalibration,
      },
      txIds: [],
      resultStatus: "APPLIED",
      error: null,
    });
  } catch (error) {
    logger.warn(
      { err: error, positionsAtRecalibration },
      "signal weights recalibration journal append failed after persistence",
    );
  }

  try {
    await input.lessonRepository.append(
      LessonSchema.parse({
        id: input.idGen(),
        rule: formatDarwinRule({
          positionsAtRecalibration,
          changes: recalculated.changes,
          rationale: recalculated.rationale,
        }),
        tags: ["evolution", "signal_weights", "darwin"],
        outcome: "evolution",
        role: null,
        pinned: false,
        createdAt: now,
      }),
    );
  } catch (error) {
    logger.warn(
      { err: error, positionsAtRecalibration },
      "signal weights recalibration lesson append failed after persistence",
    );
  }

  return {
    positionsAtRecalibration,
    changes: recalculated.changes,
    rationale: recalculated.rationale,
  };
}
