import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeStores } from "../../src/runtime/createRuntimeStores.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-runtime-"),
  );
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("runtime stores", () => {
  it("creates file-backed repositories and shared data paths in one place", async () => {
    const directory = await makeTempDir();
    const stores = createRuntimeStores({
      dataDir: directory,
      baseScreeningPolicy: {
        timeframe: "5m",
        minMarketCapUsd: 100_000,
        maxMarketCapUsd: 10_000_000,
        minTvlUsd: 10_000,
        minVolumeUsd: 500,
        minFeeActiveTvlRatio: 0.05,
        minFeePerTvl24h: 0.01,
        minOrganic: 60,
        minHolderCount: 500,
        allowedBinSteps: [80],
        blockedLaunchpads: [],
        blockedTokenMints: [],
        blockedDeployers: [],
        allowedPairTypes: ["volatile"],
        maxTopHolderPct: 30,
        maxBotHolderPct: 20,
        maxBundleRiskPct: 20,
        maxWashTradingRiskPct: 20,
        rejectDuplicatePoolExposure: true,
        rejectDuplicateTokenExposure: true,
        shortlistLimit: 5,
      },
    });

    await stores.lessonRepository.append({
      id: "01JSH7N7B6M8W1VQF4Z8V3V9X1",
      createdAt: "2026-04-22T00:00:00.000Z",
      role: "GENERAL",
      outcome: "good",
      rule: "keep fees above floor",
      tags: ["fees"],
      pinned: false,
    });

    expect(stores.paths.dataDir).toBe(directory);
    expect(stores.paths.positionsFilePath).toBe(
      path.join(directory, "positions.json"),
    );
    expect(stores.paths.lessonsFilePath).toBe(
      path.join(directory, "lessons.json"),
    );
    expect(await stores.lessonRepository.list()).toHaveLength(1);
    await expect(fs.access(directory)).resolves.toBeUndefined();
  }, 10_000);
});
