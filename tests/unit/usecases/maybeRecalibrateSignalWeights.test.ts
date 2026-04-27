import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileLessonRepository } from "../../../src/adapters/storage/LessonRepository.js";
import { FilePerformanceRepository } from "../../../src/adapters/storage/PerformanceRepository.js";
import { FileSignalWeightsStore } from "../../../src/adapters/storage/SignalWeightsStore.js";
import { JournalRepository } from "../../../src/adapters/storage/JournalRepository.js";
import { maybeRecalibrateSignalWeights } from "../../../src/app/usecases/maybeRecalibrateSignalWeights.js";
import { type PerformanceRecord } from "../../../src/domain/entities/PerformanceRecord.js";
import * as signalWeightRules from "../../../src/domain/rules/signalWeightRules.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-darwin-"),
  );
  tempDirs.push(directory);
  return directory;
}

function buildPerformance(
  overrides: Partial<PerformanceRecord> = {},
): PerformanceRecord {
  return {
    positionId: "pos_001",
    wallet: "wallet_001",
    pool: "pool_001",
    poolName: "SOL-USDC",
    baseMint: "mint_sol",
    strategy: "bid_ask",
    binStep: 100,
    binRangeLower: 10,
    binRangeUpper: 20,
    volatility: 12,
    feeTvlRatio: 0.12,
    organicScore: 75,
    amountSol: 1,
    initialValueUsd: 100,
    finalValueUsd: 105,
    feesEarnedUsd: 2,
    pnlUsd: 5,
    pnlPct: 5,
    rangeEfficiencyPct: 80,
    minutesHeld: 120,
    minutesInRange: 96,
    closeReason: "take_profit",
    deployedAt: "2026-04-22T00:00:00.000Z",
    closedAt: "2026-04-22T02:00:00.000Z",
    recordedAt: "2026-04-22T02:00:00.000Z",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("maybeRecalibrateSignalWeights", () => {
  it("skips when darwin flag is disabled", async () => {
    const directory = await makeTempDir();
    const lessonsFilePath = path.join(directory, "lessons.json");

    const result = await maybeRecalibrateSignalWeights({
      performanceRepository: new FilePerformanceRepository({
        filePath: lessonsFilePath,
      }),
      signalWeightsStore: new FileSignalWeightsStore({
        filePath: path.join(directory, "signal-weights.json"),
      }),
      lessonRepository: new FileLessonRepository({ filePath: lessonsFilePath }),
      journalRepository: new JournalRepository({
        filePath: path.join(directory, "journal.jsonl"),
      }),
      darwinEnabled: false,
      now: () => "2026-04-22T12:00:00.000Z",
      idGen: () => "01ARZ3NDEKTSV4RRFFQ69G5FC1",
    });

    expect(result).toEqual({
      skipped: true,
      reason: "flag_disabled",
    });
  });

  it("applies recalibration on every tenth performance when enabled", async () => {
    const directory = await makeTempDir();
    const lessonsFilePath = path.join(directory, "lessons.json");
    const performanceRepository = new FilePerformanceRepository({
      filePath: lessonsFilePath,
    });
    const lessonRepository = new FileLessonRepository({
      filePath: lessonsFilePath,
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const signalWeightsStore = new FileSignalWeightsStore({
      filePath: path.join(directory, "signal-weights.json"),
    });

    for (let index = 0; index < 10; index += 1) {
      await performanceRepository.append(
        buildPerformance({
          positionId: `pos_${index}`,
          feeTvlRatio: 0.1 + index * 0.02,
          pnlPct: 1 + index * 2,
        }),
      );
    }

    const result = await maybeRecalibrateSignalWeights({
      performanceRepository,
      signalWeightsStore,
      lessonRepository,
      journalRepository,
      darwinEnabled: true,
      now: () => "2026-04-22T12:00:00.000Z",
      idGen: () => "01ARZ3NDEKTSV4RRFFQ69G5FC2",
    });

    expect(result.skipped).not.toBe(true);
    if (result.skipped) {
      throw new Error("expected signal weights recalibration to run");
    }
    expect(result.changes.feeToTvl?.weight).toBeGreaterThan(1);
    expect((await signalWeightsStore.load()).feeToTvl.weight).toBeGreaterThan(
      1,
    );
    expect(
      (await lessonRepository.list()).some((lesson) =>
        lesson.rule.includes("AUTO-DARWIN"),
      ),
    ).toBe(true);
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("SIGNAL_WEIGHTS_RECALIBRATED");

    const snapshot = await signalWeightsStore.snapshot();
    expect(snapshot.metadata.positionsAtRecalibration).toBe(10);

    const retry = await maybeRecalibrateSignalWeights({
      performanceRepository,
      signalWeightsStore,
      lessonRepository,
      journalRepository,
      darwinEnabled: true,
      now: () => "2026-04-22T12:01:00.000Z",
      idGen: () => "01ARZ3NDEKTSV4RRFFQ69G5FC9",
    });

    expect(retry).toEqual({
      skipped: true,
      reason: "already_recalibrated_for_position_count",
    });
    expect(
      (await lessonRepository.list()).filter((lesson) =>
        lesson.rule.includes("AUTO-DARWIN"),
      ),
    ).toHaveLength(1);
  });

  it("persists recalibration metadata even when recalculated changes are empty", async () => {
    const directory = await makeTempDir();
    const lessonsFilePath = path.join(directory, "lessons.json");
    const performanceRepository = new FilePerformanceRepository({
      filePath: lessonsFilePath,
    });
    const lessonRepository = new FileLessonRepository({
      filePath: lessonsFilePath,
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const signalWeightsStore = new FileSignalWeightsStore({
      filePath: path.join(directory, "signal-weights.json"),
    });

    for (let index = 0; index < 10; index += 1) {
      await performanceRepository.append(
        buildPerformance({
          positionId: `pos_noop_${index}`,
        }),
      );
    }

    const recalibrateSpy = vi.spyOn(signalWeightRules, "recalculateWeights");
    recalibrateSpy.mockReturnValue({
      changes: {},
      rationale: { noop: "no meaningful signal drift" },
    });

    try {
      const first = await maybeRecalibrateSignalWeights({
        performanceRepository,
        signalWeightsStore,
        lessonRepository,
        journalRepository,
        darwinEnabled: true,
        now: () => "2026-04-22T12:00:00.000Z",
        idGen: () => "noop_recalibration",
      });

      expect(first.skipped).not.toBe(true);
      if (first.skipped) {
        throw new Error("expected no-op recalibration result");
      }
      expect(first.changes).toEqual({});

      const snapshot = await signalWeightsStore.snapshot();
      expect(snapshot.metadata.positionsAtRecalibration).toBe(10);

      const second = await maybeRecalibrateSignalWeights({
        performanceRepository,
        signalWeightsStore,
        lessonRepository,
        journalRepository,
        darwinEnabled: true,
        now: () => "2026-04-22T12:01:00.000Z",
        idGen: () => "noop_recalibration_retry",
      });

      expect(second).toEqual({
        skipped: true,
        reason: "already_recalibrated_for_position_count",
      });
    } finally {
      recalibrateSpy.mockRestore();
    }
  });
});
