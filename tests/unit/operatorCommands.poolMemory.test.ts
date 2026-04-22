import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MockPriceGateway } from "../../src/adapters/pricing/PriceGateway.js";
import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { FilePoolMemoryRepository } from "../../src/adapters/storage/PoolMemoryRepository.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { MockWalletGateway } from "../../src/adapters/wallet/WalletGateway.js";
import { ActionQueue } from "../../src/app/services/ActionQueue.js";
import { executeOperatorCommand, parseOperatorCommand } from "../../src/app/usecases/operatorCommands.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-v2-pool-cmd-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("operator commands pool memory", () => {
  it("parses pool memory commands", () => {
    expect(parseOperatorCommand({ raw: "pool memory pool_001" })).toEqual({
      kind: "POOL_MEMORY",
      poolAddress: "pool_001",
    });
    expect(parseOperatorCommand({ raw: "pool cooldown pool_001 4" })).toEqual({
      kind: "POOL_COOLDOWN",
      poolAddress: "pool_001",
      hours: 4,
    });
  });

  it("executes pool note and cooldown commands", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });
    const poolMemoryRepository = new FilePoolMemoryRepository({
      filePath: path.join(directory, "pool-memory.json"),
    });

    const noteResult = await executeOperatorCommand({
      command: parseOperatorCommand({
        raw: "pool note pool_001 watch afternoon fade",
      }),
      wallet: "wallet_001",
      requestedAt: "2026-04-22T12:00:00.000Z",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      poolMemoryRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 1,
            asOf: "2026-04-22T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-22T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: {
        minReserveUsd: 10,
        dailyLossLimitPct: 8,
        circuitBreakerCooldownMin: 180,
        maxCapitalUsagePct: 80,
        maxPoolExposurePct: 45,
        maxTokenExposurePct: 45,
        maxConcurrentPositions: 3,
        maxNewDeploysPerHour: 2,
        maxRebalancesPerPosition: 2,
      },
    });

    expect(noteResult.text).toBe("pool note added");

    const cooldownResult = await executeOperatorCommand({
      command: parseOperatorCommand({
        raw: "pool cooldown pool_001 4",
      }),
      wallet: "wallet_001",
      requestedAt: "2026-04-22T12:00:00.000Z",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      poolMemoryRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 1,
            asOf: "2026-04-22T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-22T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: {
        minReserveUsd: 10,
        dailyLossLimitPct: 8,
        circuitBreakerCooldownMin: 180,
        maxCapitalUsagePct: 80,
        maxPoolExposurePct: 45,
        maxTokenExposurePct: 45,
        maxConcurrentPositions: 3,
        maxNewDeploysPerHour: 2,
        maxRebalancesPerPosition: 2,
      },
    });

    expect(cooldownResult.text).toContain("pool cooldown set until");

    const showResult = await executeOperatorCommand({
      command: parseOperatorCommand({
        raw: "pool memory pool_001",
      }),
      wallet: "wallet_001",
      requestedAt: "2026-04-22T12:00:00.000Z",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      poolMemoryRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 1,
            asOf: "2026-04-22T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-22T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: {
        minReserveUsd: 10,
        dailyLossLimitPct: 8,
        circuitBreakerCooldownMin: 180,
        maxCapitalUsagePct: 80,
        maxPoolExposurePct: 45,
        maxTokenExposurePct: 45,
        maxConcurrentPositions: 3,
        maxNewDeploysPerHour: 2,
        maxRebalancesPerPosition: 2,
      },
    });

    expect(showResult.text).toContain("watch afternoon fade");

    const clearResult = await executeOperatorCommand({
      command: parseOperatorCommand({
        raw: "pool cooldown_clear pool_001",
      }),
      wallet: "wallet_001",
      requestedAt: "2026-04-22T12:00:00.000Z",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      poolMemoryRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 1,
            asOf: "2026-04-22T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-22T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: {
        minReserveUsd: 10,
        dailyLossLimitPct: 8,
        circuitBreakerCooldownMin: 180,
        maxCapitalUsagePct: 80,
        maxPoolExposurePct: 45,
        maxTokenExposurePct: 45,
        maxConcurrentPositions: 3,
        maxNewDeploysPerHour: 2,
        maxRebalancesPerPosition: 2,
      },
    });

    expect(clearResult.text).toBe("pool cooldown cleared");
  });
});
