import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JournalRepository } from "../../../src/adapters/storage/JournalRepository.js";
import { FilePoolMemoryRepository } from "../../../src/adapters/storage/PoolMemoryRepository.js";
import { recordPoolDeploy } from "../../../src/app/usecases/recordPoolDeploy.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-pool-deploy-"),
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

function buildDeploy(
  overrides: Partial<Parameters<typeof recordPoolDeploy>[0]["deploy"]> = {},
) {
  return {
    deployedAt: "2026-04-22T00:00:00.000Z",
    closedAt: "2026-04-22T02:00:00.000Z",
    pnlPct: 5,
    pnlUsd: 5,
    rangeEfficiencyPct: 80,
    minutesHeld: 120,
    closeReason: "take_profit" as const,
    strategy: "bid_ask" as const,
    volatilityAtDeploy: 12,
    ...overrides,
  };
}

describe("recordPoolDeploy", () => {
  it("creates a new entry on first deploy", async () => {
    const directory = await makeTempDir();
    const repository = new FilePoolMemoryRepository({
      filePath: path.join(directory, "pool-memory.json"),
    });

    const entry = await recordPoolDeploy({
      poolMemoryRepository: repository,
      poolAddress: "pool_001",
      name: "SOL-USDC",
      baseMint: "mint_sol",
      deploy: buildDeploy(),
      now: "2026-04-22T02:00:00.000Z",
    });

    expect(entry.totalDeploys).toBe(1);
    expect(entry.avgPnlPct).toBe(5);
    expect(entry.winRatePct).toBe(100);
  });

  it("recomputes aggregates and keeps only the last 50 deploys", async () => {
    const directory = await makeTempDir();
    const repository = new FilePoolMemoryRepository({
      filePath: path.join(directory, "pool-memory.json"),
    });

    for (let index = 0; index < 51; index += 1) {
      await recordPoolDeploy({
        poolMemoryRepository: repository,
        poolAddress: "pool_001",
        name: "SOL-USDC",
        baseMint: "mint_sol",
        deploy: buildDeploy({
          deployedAt: `2026-04-22T00:${String(index).padStart(2, "0")}:00.000Z`,
          closedAt: `2026-04-22T01:${String(index).padStart(2, "0")}:00.000Z`,
          pnlPct: index % 2 === 0 ? 3 : -2,
          pnlUsd: index % 2 === 0 ? 3 : -2,
        }),
        now: "2026-04-22T12:00:00.000Z",
      });
    }

    const entry = await repository.get("pool_001");
    expect(entry?.totalDeploys).toBe(50);
    expect(entry?.deploys).toHaveLength(50);
    expect(entry?.winRatePct).toBeGreaterThan(0);
  });

  it("sets cooldown for default cooldown reason and emits journal", async () => {
    const directory = await makeTempDir();
    const repository = new FilePoolMemoryRepository({
      filePath: path.join(directory, "pool-memory.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });

    const entry = await recordPoolDeploy({
      poolMemoryRepository: repository,
      journalRepository,
      poolAddress: "pool_001",
      name: "SOL-USDC",
      baseMint: "mint_sol",
      deploy: buildDeploy({
        closeReason: "volume_collapse",
        pnlPct: -6,
        pnlUsd: -6,
      }),
      now: "2026-04-22T02:00:00.000Z",
    });

    expect(entry.cooldownUntil).toBe("2026-04-22T06:00:00.000Z");
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("POOL_MEMORY_UPDATED");
  });

  it("does not duplicate deploy history for the same position", async () => {
    const directory = await makeTempDir();
    const repository = new FilePoolMemoryRepository({
      filePath: path.join(directory, "pool-memory.json"),
    });

    await recordPoolDeploy({
      poolMemoryRepository: repository,
      poolAddress: "pool_001",
      name: "SOL-USDC",
      baseMint: "mint_sol",
      deploy: buildDeploy({
        positionId: "pos_001",
        sourceActionId: "action_001",
      }),
      now: "2026-04-22T02:00:00.000Z",
    });
    const entry = await recordPoolDeploy({
      poolMemoryRepository: repository,
      poolAddress: "pool_001",
      name: "SOL-USDC",
      baseMint: "mint_sol",
      deploy: buildDeploy({
        positionId: "pos_001",
        sourceActionId: "action_001",
        pnlPct: 20,
      }),
      now: "2026-04-22T02:05:00.000Z",
    });

    expect(entry.totalDeploys).toBe(1);
    expect(entry.deploys).toHaveLength(1);
    expect(entry.avgPnlPct).toBe(5);
  });

  it("does not extend cooldown when the same deploy is replayed", async () => {
    const directory = await makeTempDir();
    const repository = new FilePoolMemoryRepository({
      filePath: path.join(directory, "pool-memory.json"),
    });

    await recordPoolDeploy({
      poolMemoryRepository: repository,
      poolAddress: "pool_001",
      name: "SOL-USDC",
      baseMint: "mint_sol",
      deploy: buildDeploy({
        closeReason: "volume_collapse",
        positionId: "pos_001",
        sourceActionId: "action_001",
        pnlPct: -6,
        pnlUsd: -6,
      }),
      now: "2026-04-22T02:00:00.000Z",
    });
    const replayed = await recordPoolDeploy({
      poolMemoryRepository: repository,
      poolAddress: "pool_001",
      name: "SOL-USDC",
      baseMint: "mint_sol",
      deploy: buildDeploy({
        closeReason: "volume_collapse",
        positionId: "pos_001",
        sourceActionId: "action_001",
        pnlPct: -6,
        pnlUsd: -6,
      }),
      now: "2026-04-22T05:00:00.000Z",
    });

    expect(replayed.totalDeploys).toBe(1);
    expect(replayed.cooldownUntil).toBe("2026-04-22T06:00:00.000Z");
  });

  it("returns the updated entry when pool memory persistence succeeds but journaling fails", async () => {
    const directory = await makeTempDir();
    const repository = new FilePoolMemoryRepository({
      filePath: path.join(directory, "pool-memory.json"),
    });
    const failingJournalRepository = {
      async append() {
        throw new Error("journal unavailable");
      },
    } as unknown as JournalRepository;

    const entry = await recordPoolDeploy({
      poolMemoryRepository: repository,
      journalRepository: failingJournalRepository,
      poolAddress: "pool_warn",
      name: "SOL-USDC",
      baseMint: "mint_sol",
      deploy: buildDeploy(),
      now: "2026-04-22T02:00:00.000Z",
    });

    expect(entry.totalDeploys).toBe(1);
    expect((await repository.get("pool_warn"))?.totalDeploys).toBe(1);
  });
});
