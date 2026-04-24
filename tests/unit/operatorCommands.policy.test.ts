import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileRuntimePolicyStore } from "../../src/adapters/config/RuntimePolicyStore.js";
import { MockPriceGateway } from "../../src/adapters/pricing/PriceGateway.js";
import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { MockWalletGateway } from "../../src/adapters/wallet/WalletGateway.js";
import { ActionQueue } from "../../src/app/services/ActionQueue.js";
import { DefaultPolicyProvider } from "../../src/app/services/PolicyProvider.js";
import {
  executeOperatorCommand,
  parseOperatorCommand,
} from "../../src/app/usecases/operatorCommands.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-policy-cmd-"),
  );
  tempDirs.push(directory);
  return directory;
}

const basePolicy = {
  timeframe: "5m",
  minMarketCapUsd: 150_000,
  maxMarketCapUsd: 10_000_000,
  minTvlUsd: 10_000,
  minVolumeUsd: 5_000,
  minFeeActiveTvlRatio: 0.05,
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
} as const;

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("operator commands policy", () => {
  it("shows merged policy and resets overrides", async () => {
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
    const runtimePolicyStore = new FileRuntimePolicyStore({
      filePath: path.join(directory, "policy-overrides.json"),
      basePolicy,
    });
    await runtimePolicyStore.applyOverrides({
      minFeeActiveTvlRatio: 0.08,
    });
    const policyProvider = new DefaultPolicyProvider({
      basePolicy,
      runtimePolicyStore,
    });

    const showResult = await executeOperatorCommand({
      command: parseOperatorCommand({ raw: "policy show" }),
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      runtimePolicyStore,
      policyProvider,
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

    expect(showResult.text).toContain('"minFeeActiveTvlRatio": 0.08');

    const resetResult = await executeOperatorCommand({
      command: parseOperatorCommand({ raw: "policy reset confirm=true" }),
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      runtimePolicyStore,
      policyProvider,
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

    expect(resetResult.text).toBe("policy overrides reset");
    expect((await runtimePolicyStore.snapshot()).overrides).toEqual({});
    await expect(
      fs.access(path.join(directory, "policy-overrides.json")),
    ).rejects.toThrow();
  });
});
