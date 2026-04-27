import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MockPriceGateway } from "../../src/adapters/pricing/PriceGateway.js";
import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { FileLessonRepository } from "../../src/adapters/storage/LessonRepository.js";
import { FilePerformanceRepository } from "../../src/adapters/storage/PerformanceRepository.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { MockWalletGateway } from "../../src/adapters/wallet/WalletGateway.js";
import { ActionQueue } from "../../src/app/services/ActionQueue.js";
import {
  executeOperatorCommand,
  parseOperatorCommand,
} from "../../src/app/usecases/operatorCommands.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-lesson-cmd-"),
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

describe("operatorCommands lessons", () => {
  it("parses lessons commands", () => {
    expect(
      parseOperatorCommand({
        raw: "lessons list --role SCREENER --pinned --limit 5",
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "LESSONS_LIST",
        role: "SCREENER",
        pinned: true,
        limit: 5,
      }),
    );
    expect(parseOperatorCommand({ raw: "lessons clear confirm=true" })).toEqual(
      {
        kind: "LESSONS_CLEAR",
        confirm: true,
      },
    );
    expect(() =>
      parseOperatorCommand({
        raw: "lessons list --role",
      }),
    ).toThrow(/--role requires a value/i);
    expect(() =>
      parseOperatorCommand({
        raw: "lessons list --tag",
      }),
    ).toThrow(/--tag requires a value/i);
  });

  it("executes lesson add/list and performance summary commands", async () => {
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
    const lessonsFilePath = path.join(directory, "lessons.json");
    const lessonRepository = new FileLessonRepository({
      filePath: lessonsFilePath,
    });
    const performanceRepository = new FilePerformanceRepository({
      filePath: lessonsFilePath,
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    const addResult = await executeOperatorCommand({
      command: parseOperatorCommand({
        raw: "lessons add Avoid thin pools after collapse",
      }),
      wallet: "wallet_001",
      requestedAt: "2026-04-22T12:00:00.000Z",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      lessonRepository,
      performanceRepository,
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

    expect(addResult.text).toBe("lesson added");

    const listResult = await executeOperatorCommand({
      command: parseOperatorCommand({ raw: "lessons list" }),
      wallet: "wallet_001",
      requestedAt: "2026-04-22T12:00:00.000Z",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      lessonRepository,
      performanceRepository,
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

    expect(listResult.text).toContain("Avoid thin pools after collapse");

    const summaryResult = await executeOperatorCommand({
      command: parseOperatorCommand({ raw: "performance summary" }),
      wallet: "wallet_001",
      requestedAt: "2026-04-22T12:00:00.000Z",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      lessonRepository,
      performanceRepository,
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

    expect(summaryResult.text).toContain("closed: 0");
  });

  it("appends a LESSON_MANUAL_ADDED journal event when an operator adds a lesson", async () => {
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
    const lessonsFilePath = path.join(directory, "lessons.json");
    const lessonRepository = new FileLessonRepository({
      filePath: lessonsFilePath,
    });
    const performanceRepository = new FilePerformanceRepository({
      filePath: lessonsFilePath,
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    await executeOperatorCommand({
      command: parseOperatorCommand({
        raw: "lessons add Avoid thin pools after collapse",
      }),
      wallet: "wallet_001",
      requestedAt: "2026-04-22T12:00:00.000Z",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      lessonRepository,
      performanceRepository,
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

    const journal = await journalRepository.list();
    const event = journal.find(
      (entry) => entry.eventType === "LESSON_MANUAL_ADDED",
    );
    expect(event).toBeDefined();
    expect(event?.actor).toBe("operator");
    expect(event?.resultStatus).toBe("ADDED");
  });
});
