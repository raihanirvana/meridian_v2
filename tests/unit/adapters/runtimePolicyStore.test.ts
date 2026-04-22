import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileRuntimePolicyStore,
  PolicyStoreCorruptError,
} from "../../../src/adapters/config/RuntimePolicyStore.js";
import { type ScreeningPolicy } from "../../../src/domain/rules/screeningRules.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-v2-policy-store-"));
  tempDirs.push(directory);
  return directory;
}

function buildPolicy(overrides: Partial<ScreeningPolicy> = {}): ScreeningPolicy {
  return {
    minMarketCapUsd: 150_000,
    maxMarketCapUsd: 10_000_000,
    minTvlUsd: 10_000,
    minVolumeUsd: 5_000,
    minFeeActiveTvlRatio: 0.05,
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

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("runtime policy store", () => {
  it("returns base policy when no overrides file exists", async () => {
    const directory = await makeTempDir();
    const store = new FileRuntimePolicyStore({
      filePath: path.join(directory, "policy-overrides.json"),
      basePolicy: buildPolicy(),
    });

    const snapshot = await store.snapshot();

    expect(snapshot.policy.minFeeActiveTvlRatio).toBe(0.05);
    expect(snapshot.overrides).toEqual({});
  });

  it("applies overrides and returns merged snapshot metadata", async () => {
    const directory = await makeTempDir();
    const store = new FileRuntimePolicyStore({
      filePath: path.join(directory, "policy-overrides.json"),
      basePolicy: buildPolicy(),
    });

    await store.applyOverrides(
      {
        minFeeActiveTvlRatio: 0.08,
        minOrganic: 66,
      },
      {
        lastEvolvedAt: "2026-04-22T12:00:00.000Z",
        positionsAtEvolution: 10,
        rationale: {
          minOrganic: "winner gap observed",
        },
      },
    );

    const snapshot = await store.snapshot();

    expect(snapshot.overrides).toEqual({
      minFeeActiveTvlRatio: 0.08,
      minOrganic: 66,
    });
    expect(snapshot.policy.minFeeActiveTvlRatio).toBe(0.08);
    expect(snapshot.policy.minOrganic).toBe(66);
    expect(snapshot.lastEvolvedAt).toBe("2026-04-22T12:00:00.000Z");
    expect(snapshot.positionsAtEvolution).toBe(10);
    expect(snapshot.rationale.minOrganic).toBe("winner gap observed");
  });

  it("throws PolicyStoreCorruptError for invalid file content", async () => {
    const directory = await makeTempDir();
    const filePath = path.join(directory, "policy-overrides.json");
    await fs.writeFile(filePath, "{\"broken\":true}", "utf8");

    const store = new FileRuntimePolicyStore({
      filePath,
      basePolicy: buildPolicy(),
    });

    await expect(store.snapshot()).rejects.toBeInstanceOf(PolicyStoreCorruptError);
  });
});
