import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { FileLessonRepository } from "../../src/adapters/storage/LessonRepository.js";
import { FilePerformanceRepository } from "../../src/adapters/storage/PerformanceRepository.js";
import { recordPositionPerformance } from "../../src/app/usecases/recordPositionPerformance.js";
import { type PerformanceRecord } from "../../src/domain/entities/PerformanceRecord.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-lessons-"),
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
    baseMint: "mint_base",
    strategy: "bid_ask",
    binStep: 100,
    binRangeLower: 10,
    binRangeUpper: 20,
    volatility: 12,
    feeTvlRatio: 1.2,
    organicScore: 80,
    amountSol: 1,
    initialValueUsd: 100,
    finalValueUsd: 120,
    feesEarnedUsd: 3,
    pnlUsd: 23,
    pnlPct: 23,
    rangeEfficiencyPct: 88,
    minutesHeld: 120,
    minutesInRange: 105,
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

describe("recordPositionPerformance", () => {
  it("stores performance and lesson for meaningful outcomes", async () => {
    const directory = await makeTempDir();
    const filePath = path.join(directory, "lessons.json");
    const lessonRepository = new FileLessonRepository({ filePath });
    const performanceRepository = new FilePerformanceRepository({ filePath });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });

    const result = await recordPositionPerformance({
      performance: buildPerformance(),
      lessonRepository,
      performanceRepository,
      journalRepository,
      idGen: () => "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      now: () => "2026-04-22T02:00:00.000Z",
    });

    expect(result.lesson?.id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(await performanceRepository.list()).toHaveLength(1);
    expect(await lessonRepository.list()).toHaveLength(1);
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("LESSON_RECORDED");
  });

  it("skips suspicious unit mix records", async () => {
    const directory = await makeTempDir();
    const filePath = path.join(directory, "lessons.json");
    const lessonRepository = new FileLessonRepository({ filePath });
    const performanceRepository = new FilePerformanceRepository({ filePath });

    const result = await recordPositionPerformance({
      performance: buildPerformance({
        amountSol: 2,
        finalValueUsd: 2,
      }),
      lessonRepository,
      performanceRepository,
      idGen: () => "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      now: () => "2026-04-22T02:00:00.000Z",
    });

    expect(result).toEqual({
      skipped: true,
      reason: "suspicious_unit_mix",
    });
    expect(await performanceRepository.list()).toHaveLength(0);
    expect(await lessonRepository.list()).toHaveLength(0);
  });

  it("stores neutral performance without creating a lesson but still records a journal event", async () => {
    const directory = await makeTempDir();
    const filePath = path.join(directory, "lessons.json");
    const lessonRepository = new FileLessonRepository({ filePath });
    const performanceRepository = new FilePerformanceRepository({ filePath });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });

    const result = await recordPositionPerformance({
      performance: buildPerformance({
        pnlUsd: 2,
        pnlPct: 2,
      }),
      lessonRepository,
      performanceRepository,
      journalRepository,
      idGen: () => "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      now: () => "2026-04-22T02:00:00.000Z",
    });

    expect(result.performance?.positionId).toBe("pos_001");
    expect(result.lesson).toBeNull();
    expect(await performanceRepository.list()).toHaveLength(1);
    expect(await lessonRepository.list()).toHaveLength(0);
    const journal = await journalRepository.list();
    expect(journal).toHaveLength(1);
    expect(journal[0]?.eventType).toBe("PERFORMANCE_RECORDED");
  });

  it("reuses existing performance and continues lesson recording on retry", async () => {
    const directory = await makeTempDir();
    const filePath = path.join(directory, "lessons.json");
    const lessonRepository = new FileLessonRepository({ filePath });
    const performanceRepository = new FilePerformanceRepository({ filePath });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });

    await performanceRepository.append(buildPerformance());

    const result = await recordPositionPerformance({
      performance: buildPerformance({
        finalValueUsd: 0,
        pnlUsd: 0,
        pnlPct: 0,
      }),
      lessonRepository,
      performanceRepository,
      journalRepository,
      idGen: () => "01ARZ3NDEKTSV4RRFFQ69G5FB2",
      now: () => "2026-04-22T02:00:00.000Z",
    });

    expect(result.performance?.finalValueUsd).toBe(120);
    expect(result.lesson?.id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FB2");
    expect(await performanceRepository.list()).toHaveLength(1);
    expect(await lessonRepository.list()).toHaveLength(1);
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toEqual(["LESSON_RECORDED"]);
  });
});
