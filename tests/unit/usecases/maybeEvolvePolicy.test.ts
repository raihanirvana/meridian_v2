import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileRuntimePolicyStore } from "../../../src/adapters/config/RuntimePolicyStore.js";
import { JournalRepository } from "../../../src/adapters/storage/JournalRepository.js";
import { FileLessonRepository } from "../../../src/adapters/storage/LessonRepository.js";
import { FilePerformanceRepository } from "../../../src/adapters/storage/PerformanceRepository.js";
import { maybeEvolvePolicy } from "../../../src/app/usecases/maybeEvolvePolicy.js";
import { type PerformanceRecord } from "../../../src/domain/entities/PerformanceRecord.js";
import { type ScreeningPolicy } from "../../../src/domain/rules/screeningRules.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-evolve-"),
  );
  tempDirs.push(directory);
  return directory;
}

function buildPolicy(
  overrides: Partial<ScreeningPolicy> = {},
): ScreeningPolicy {
  return {
    timeframe: "5m",
    minMarketCapUsd: 150_000,
    maxMarketCapUsd: 10_000_000,
    minTvlUsd: 10_000,
    minVolumeUsd: 5_000,
    minFeeActiveTvlRatio: 0.1,
    minFeePerTvl24h: 0.01,
    minOrganic: 60,
    minHolderCount: 500,
    allowedBinSteps: [80, 100, 125],
    blockedLaunchpads: [],
    blockedTokenMints: [],
    blockedDeployers: [],
    allowedPairTypes: ["volatile", "stable"],
    maxTopHolderPct: 35,
    maxBotHolderPct: 20,
    maxBundleRiskPct: 20,
    maxWashTradingRiskPct: 20,
    rejectDuplicatePoolExposure: true,
    rejectDuplicateTokenExposure: true,
    shortlistLimit: 2,
    ...overrides,
  };
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

describe("maybeEvolvePolicy", () => {
  it("skips when closed positions count is not a multiple of five", async () => {
    const directory = await makeTempDir();
    const filePath = path.join(directory, "lessons.json");
    const performanceRepository = new FilePerformanceRepository({ filePath });

    for (let index = 0; index < 4; index += 1) {
      await performanceRepository.append(
        buildPerformance({ positionId: `pos_${index}` }),
      );
    }

    const result = await maybeEvolvePolicy({
      performanceRepository,
      runtimePolicyStore: new FileRuntimePolicyStore({
        filePath: path.join(directory, "policy-overrides.json"),
        basePolicy: buildPolicy(),
      }),
      lessonRepository: new FileLessonRepository({ filePath }),
      journalRepository: new JournalRepository({
        filePath: path.join(directory, "journal.jsonl"),
      }),
      now: () => "2026-04-22T12:00:00.000Z",
      idGen: () => "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });

    expect(result).toEqual({
      skipped: true,
      reason: "position_count_gate",
    });
  });

  it("writes store, journal, and lesson when evolution produces changes", async () => {
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
    const runtimePolicyStore = new FileRuntimePolicyStore({
      filePath: path.join(directory, "policy-overrides.json"),
      basePolicy: buildPolicy(),
    });

    const records = [
      buildPerformance({
        positionId: "w1",
        pnlPct: 10,
        feeTvlRatio: 0.3,
        organicScore: 88,
      }),
      buildPerformance({
        positionId: "w2",
        pnlPct: 9,
        feeTvlRatio: 0.28,
        organicScore: 86,
      }),
      buildPerformance({
        positionId: "w3",
        pnlPct: 8,
        feeTvlRatio: 0.32,
        organicScore: 84,
      }),
      buildPerformance({
        positionId: "l1",
        pnlPct: -8,
        pnlUsd: -8,
        feeTvlRatio: 0.07,
        organicScore: 61,
      }),
      buildPerformance({
        positionId: "l2",
        pnlPct: -7,
        pnlUsd: -7,
        feeTvlRatio: 0.08,
        organicScore: 62,
      }),
    ];
    for (const record of records) {
      await performanceRepository.append(record);
    }

    const result = await maybeEvolvePolicy({
      performanceRepository,
      runtimePolicyStore,
      lessonRepository,
      journalRepository,
      now: () => "2026-04-22T12:00:00.000Z",
      idGen: () => "01ARZ3NDEKTSV4RRFFQ69G5FB0",
    });

    expect(result).toMatchObject({
      positionsAtEvolution: 5,
    });
    expect(Object.keys(result.changes)).not.toHaveLength(0);
    expect((await runtimePolicyStore.snapshot()).overrides).toMatchObject(
      result.changes,
    );
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("POLICY_EVOLVED");
    expect(await lessonRepository.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
          outcome: "evolution",
        }),
      ]),
    );
  });

  it("returns empty changes without writing when there is no usable winner/loser signal", async () => {
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
    const runtimePolicyStore = new FileRuntimePolicyStore({
      filePath: path.join(directory, "policy-overrides.json"),
      basePolicy: buildPolicy(),
    });

    for (let index = 0; index < 5; index += 1) {
      await performanceRepository.append(
        buildPerformance({
          positionId: `pos_${index}`,
          pnlPct: index === 4 ? 0 : 2,
          pnlUsd: index === 4 ? 0 : 2,
          feeTvlRatio: 0.11 + index * 0.005,
          organicScore: 70 + index,
        }),
      );
    }

    const result = await maybeEvolvePolicy({
      performanceRepository,
      runtimePolicyStore,
      lessonRepository,
      journalRepository,
      now: () => "2026-04-22T12:00:00.000Z",
      idGen: () => "01ARZ3NDEKTSV4RRFFQ69G5FB1",
    });

    expect(result).toEqual({
      positionsAtEvolution: 5,
      changes: {},
      rationale: {},
    });
    expect((await runtimePolicyStore.snapshot()).overrides).toEqual({});
    expect(await lessonRepository.list()).toHaveLength(0);
    expect(await journalRepository.list()).toHaveLength(0);
  });
});
