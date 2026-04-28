import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MockPriceGateway } from "../../src/adapters/pricing/PriceGateway.js";
import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { FileRuntimeControlStore } from "../../src/adapters/storage/RuntimeControlStore.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { MockNotifierGateway } from "../../src/adapters/telegram/NotifierGateway.js";
import { MockWalletGateway } from "../../src/adapters/wallet/WalletGateway.js";
import { ActionQueue } from "../../src/app/services/ActionQueue.js";
import { handleCliOperatorCommand } from "../../src/app/usecases/handleCliOperatorCommand.js";
import { handleTelegramOperatorCommand } from "../../src/app/usecases/handleTelegramOperatorCommand.js";
import {
  executeOperatorCommand,
  parseOperatorCommand,
} from "../../src/app/usecases/operatorCommands.js";
import { sendOperatorAlert } from "../../src/app/usecases/sendOperatorAlert.js";
import { type Action } from "../../src/domain/entities/Action.js";
import { type Position } from "../../src/domain/entities/Position.js";
import { type PortfolioRiskPolicy } from "../../src/domain/rules/riskRules.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-operator-"),
  );
  tempDirs.push(directory);
  return directory;
}

function buildPosition(overrides: Partial<Position> = {}): Position {
  return {
    positionId: "pos_001",
    poolAddress: "pool_001",
    tokenXMint: "mint_x",
    tokenYMint: "mint_y",
    baseMint: "mint_base",
    quoteMint: "mint_quote",
    wallet: "wallet_001",
    status: "OPEN",
    openedAt: "2026-04-21T00:00:00.000Z",
    lastSyncedAt: "2026-04-21T00:00:00.000Z",
    closedAt: null,
    deployAmountBase: 1,
    deployAmountQuote: 0.5,
    currentValueBase: 1,
    currentValueUsd: 20,
    feesClaimedBase: 0,
    feesClaimedUsd: 0,
    realizedPnlBase: 0,
    realizedPnlUsd: 0,
    unrealizedPnlBase: 0,
    unrealizedPnlUsd: 0,
    rebalanceCount: 0,
    partialCloseCount: 0,
    strategy: "bid_ask",
    rangeLowerBin: 10,
    rangeUpperBin: 20,
    activeBin: 15,
    outOfRangeSince: null,
    lastManagementDecision: null,
    lastManagementReason: null,
    lastWriteActionId: null,
    needsReconciliation: false,
    ...overrides,
  };
}

function buildAction(overrides: Partial<Action> = {}): Action {
  return {
    actionId: "act_001",
    type: "DEPLOY",
    status: "QUEUED",
    wallet: "wallet_001",
    positionId: null,
    idempotencyKey: "wallet_001:DEPLOY:none:test",
    requestPayload: {
      poolAddress: "pool_001",
    },
    resultPayload: null,
    txIds: [],
    error: null,
    requestedAt: "2026-04-21T12:00:00.000Z",
    startedAt: null,
    completedAt: null,
    requestedBy: "operator",
    ...overrides,
  };
}

function buildRiskPolicy(
  overrides: Partial<PortfolioRiskPolicy> = {},
): PortfolioRiskPolicy {
  return {
    maxConcurrentPositions: 3,
    maxCapitalUsagePct: 80,
    minReserveUsd: 10,
    maxTokenExposurePct: 80,
    maxPoolExposurePct: 80,
    maxRebalancesPerPosition: 2,
    dailyLossLimitPct: 8,
    circuitBreakerCooldownMin: 180,
    maxNewDeploysPerHour: 2,
    ...overrides,
  };
}

function buildDeployPayload() {
  return {
    poolAddress: "pool_002",
    tokenXMint: "mint_x2",
    tokenYMint: "mint_y2",
    baseMint: "mint_base2",
    quoteMint: "mint_quote2",
    amountBase: 1.25,
    amountQuote: 5,
    strategy: "bid_ask",
    rangeLowerBin: 10,
    rangeUpperBin: 30,
    initialActiveBin: 20,
    estimatedValueUsd: 50,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("operator commands", () => {
  it("parses supported commands including JSON payload variants", () => {
    expect(parseOperatorCommand({ raw: "/status" })).toEqual({
      kind: "STATUS",
    });

    expect(parseOperatorCommand({ raw: "positions" })).toEqual({
      kind: "POSITIONS",
    });

    expect(parseOperatorCommand({ raw: "pending-actions" })).toEqual({
      kind: "PENDING_ACTIONS",
    });

    expect(parseOperatorCommand({ raw: "close pos_001 risk breach" })).toEqual({
      kind: "REQUEST_CLOSE",
      positionId: "pos_001",
      payload: {
        reason: "risk breach",
      },
    });

    expect(
      parseOperatorCommand({
        raw: `deploy ${JSON.stringify(buildDeployPayload())}`,
      }),
    ).toEqual({
      kind: "REQUEST_DEPLOY",
      payload: buildDeployPayload(),
    });

    expect(
      parseOperatorCommand({
        raw: `rebalance pos_001 ${JSON.stringify({
          reason: "out of range",
          redeploy: buildDeployPayload(),
        })}`,
      }),
    ).toEqual({
      kind: "REQUEST_REBALANCE",
      positionId: "pos_001",
      payload: {
        reason: "out of range",
        redeploy: buildDeployPayload(),
      },
    });
  });

  it("rejects invalid commands and malformed payloads", () => {
    expect(() =>
      parseOperatorCommand({
        raw: "",
      }),
    ).toThrow(/cannot be empty/i);

    expect(() =>
      parseOperatorCommand({
        raw: "unknown",
      }),
    ).toThrow(/unknown command/i);

    expect(() =>
      parseOperatorCommand({
        raw: "deploy {bad json}",
      }),
    ).toThrow(/invalid json payload/i);
  });

  it("renders status, positions, and pending actions as read-only operator views", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    await stateRepository.upsert(buildPosition());
    await actionRepository.upsert(buildAction());

    const sharedInput = {
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      requestedAt: "2026-04-21T12:00:00.000Z",
    } as const;

    const statusResult = await executeOperatorCommand({
      ...sharedInput,
      command: { kind: "STATUS" },
    });
    expect(statusResult.command).toBe("STATUS");
    expect(statusResult.actionId).toBeNull();
    expect(statusResult.text).toMatch(/wallet balance usd/i);
    expect(statusResult.text).toMatch(/pending actions: 1/i);

    const positionsResult = await executeOperatorCommand({
      ...sharedInput,
      command: { kind: "POSITIONS" },
    });
    expect(positionsResult.text).toMatch(
      /pos_001 \| OPEN \| pool_001 \| 20\.00/,
    );

    const pendingResult = await executeOperatorCommand({
      ...sharedInput,
      command: { kind: "PENDING_ACTIONS" },
    });
    expect(pendingResult.text).toMatch(/act_001 \| DEPLOY \| QUEUED \| none/);
  });

  it("manual close request creates a queued action and does not mutate position state directly", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    await stateRepository.upsert(buildPosition());

    const result = await handleCliOperatorCommand({
      rawCommand: "close pos_001 operator requested close",
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      requestedBy: "operator",
      requestedAt: "2026-04-21T12:00:00.000Z",
    });

    expect(result.command).toBe("REQUEST_CLOSE");
    expect(result.actionId).not.toBeNull();

    const position = await stateRepository.get("pos_001");
    expect(position?.status).toBe("OPEN");

    const actions = await actionRepository.list();
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe("CLOSE");
    expect(actions[0]?.status).toBe("QUEUED");
    expect(actions[0]?.requestedBy).toBe("operator");
  });

  it("blocks manual close requests when another write action is already pending", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    await stateRepository.upsert(buildPosition());
    await actionRepository.upsert(
      buildAction({
        type: "CLAIM_FEES",
        positionId: "pos_other",
        idempotencyKey: "wallet_001:CLAIM_FEES:pos_other:test",
        requestPayload: {
          reason: "pending claim",
        },
      }),
    );

    await expect(
      handleCliOperatorCommand({
        rawCommand: "close pos_001 operator requested close",
        wallet: "wallet_001",
        actionQueue,
        stateRepository,
        actionRepository,
        journalRepository,
        walletGateway: new MockWalletGateway({
          getWalletBalance: {
            type: "success",
            value: {
              wallet: "wallet_001",
              balanceSol: 5,
              asOf: "2026-04-21T12:00:00.000Z",
            },
          },
        }),
        priceGateway: new MockPriceGateway({
          getSolPriceUsd: {
            type: "success",
            value: {
              symbol: "SOL",
              priceUsd: 20,
              asOf: "2026-04-21T12:00:00.000Z",
            },
          },
        }),
        riskPolicy: buildRiskPolicy(),
        requestedBy: "operator",
        requestedAt: "2026-04-21T12:00:00.000Z",
      }),
    ).rejects.toThrow(/close blocked by risk guard/i);

    expect(await actionRepository.listByStatuses(["QUEUED"])).toHaveLength(1);
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("CLOSE_REQUEST_BLOCKED_BY_RISK");
  });

  it("manual deploy requests enqueue work instead of bypassing the queue", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    await stateRepository.upsert(buildPosition());

    const baseInput = {
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      requestedBy: "operator" as const,
      requestedAt: "2026-04-21T12:00:00.000Z",
    };

    const deployResult = await handleCliOperatorCommand({
      ...baseInput,
      rawCommand: `deploy ${JSON.stringify(buildDeployPayload())}`,
    });
    expect(deployResult.command).toBe("REQUEST_DEPLOY");

    const actions = await actionRepository.list();
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe("DEPLOY");
    expect(actions.every((action) => action.status === "QUEUED")).toBe(true);
  });

  it("manual deploy uses portfolio.solPriceUsd and does not require a second price fetch", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    let priceCalls = 0;
    await stateRepository.upsert(buildPosition());

    const result = await handleCliOperatorCommand({
      rawCommand: `deploy ${JSON.stringify(buildDeployPayload())}`,
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      priceGateway: {
        async getSolPriceUsd() {
          priceCalls += 1;
          if (priceCalls >= 2) {
            throw new Error("second price fetch should not happen");
          }
          return {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:00:00.000Z",
          };
        },
      },
      riskPolicy: buildRiskPolicy(),
      requestedBy: "operator",
      requestedAt: "2026-04-21T12:00:00.000Z",
    });

    expect(result.command).toBe("REQUEST_DEPLOY");
    expect(priceCalls).toBe(1);
  });

  it("manual rebalance requests pass through portfolio risk guard before queueing", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    await stateRepository.upsert(buildPosition());

    const result = await handleCliOperatorCommand({
      rawCommand: `rebalance pos_001 ${JSON.stringify({
        reason: "operator rebalance",
        redeploy: buildDeployPayload(),
      })}`,
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      requestedBy: "operator",
      requestedAt: "2026-04-21T12:00:00.000Z",
    });

    expect(result.command).toBe("REQUEST_REBALANCE");
    const actions = await actionRepository.list();
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe("REBALANCE");
    expect(actions[0]?.status).toBe("QUEUED");
  });

  it("manual rebalance uses portfolio.solPriceUsd and does not require a second price fetch", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    let priceCalls = 0;
    await stateRepository.upsert(buildPosition());

    const result = await handleCliOperatorCommand({
      rawCommand: `rebalance pos_001 ${JSON.stringify({
        reason: "operator rebalance",
        redeploy: buildDeployPayload(),
      })}`,
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      priceGateway: {
        async getSolPriceUsd() {
          priceCalls += 1;
          if (priceCalls >= 2) {
            throw new Error("second price fetch should not happen");
          }
          return {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:00:00.000Z",
          };
        },
      },
      riskPolicy: buildRiskPolicy(),
      requestedBy: "operator",
      requestedAt: "2026-04-21T12:00:00.000Z",
    });

    expect(result.command).toBe("REQUEST_REBALANCE");
    expect(priceCalls).toBe(1);
  });

  it("blocks manual deploy requests that violate portfolio risk guardrails", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    await expect(
      handleCliOperatorCommand({
        rawCommand: `deploy ${JSON.stringify(buildDeployPayload())}`,
        wallet: "wallet_001",
        actionQueue,
        stateRepository,
        actionRepository,
        journalRepository,
        walletGateway: new MockWalletGateway({
          getWalletBalance: {
            type: "success",
            value: {
              wallet: "wallet_001",
              balanceSol: 5,
              asOf: "2026-04-21T12:00:00.000Z",
            },
          },
        }),
        priceGateway: new MockPriceGateway({
          getSolPriceUsd: {
            type: "success",
            value: {
              symbol: "SOL",
              priceUsd: 20,
              asOf: "2026-04-21T12:00:00.000Z",
            },
          },
        }),
        riskPolicy: buildRiskPolicy({
          maxCapitalUsagePct: 1,
        }),
        requestedBy: "operator",
        requestedAt: "2026-04-21T12:00:00.000Z",
      }),
    ).rejects.toThrow(/deploy blocked by risk guard/i);

    expect(await actionRepository.list()).toEqual([]);
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("DEPLOY_REQUEST_BLOCKED_BY_RISK");
  });

  it("blocks manual rebalance requests that violate portfolio risk guardrails", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    await stateRepository.upsert(
      buildPosition({
        rebalanceCount: 2,
      }),
    );

    await expect(
      handleCliOperatorCommand({
        rawCommand: `rebalance pos_001 ${JSON.stringify({
          reason: "operator rebalance",
          redeploy: buildDeployPayload(),
        })}`,
        wallet: "wallet_001",
        actionQueue,
        stateRepository,
        actionRepository,
        journalRepository,
        walletGateway: new MockWalletGateway({
          getWalletBalance: {
            type: "success",
            value: {
              wallet: "wallet_001",
              balanceSol: 5,
              asOf: "2026-04-21T12:00:00.000Z",
            },
          },
        }),
        priceGateway: new MockPriceGateway({
          getSolPriceUsd: {
            type: "success",
            value: {
              symbol: "SOL",
              priceUsd: 20,
              asOf: "2026-04-21T12:00:00.000Z",
            },
          },
        }),
        riskPolicy: buildRiskPolicy({
          maxRebalancesPerPosition: 2,
        }),
        requestedBy: "operator",
        requestedAt: "2026-04-21T12:00:00.000Z",
      }),
    ).rejects.toThrow(/rebalance blocked by risk guard/i);

    expect(await actionRepository.list()).toEqual([]);
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toContain("REBALANCE_REQUEST_BLOCKED_BY_RISK");
  });

  it("telegram handler replies with the rendered result after queue-safe execution", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    await stateRepository.upsert(buildPosition());

    const result = await handleTelegramOperatorCommand({
      rawCommand: "/close pos_001 telegram close",
      recipient: "chat_001",
      notifierGateway: new MockNotifierGateway({
        sendMessage: {
          type: "success",
          value: {
            delivered: true,
            channel: "telegram",
            recipient: "chat_001",
          },
        },
        sendAlert: {
          type: "success",
          value: {
            delivered: true,
            channel: "telegram",
            recipient: "chat_001",
          },
        },
      }),
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      requestedBy: "operator",
      requestedAt: "2026-04-21T12:00:00.000Z",
    });

    expect(result.command).toBe("REQUEST_CLOSE");
    expect(result.text).toMatch(/close request accepted/i);
  });

  it("still returns accepted result when telegram reply delivery fails", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    await stateRepository.upsert(buildPosition());

    const result = await handleTelegramOperatorCommand({
      rawCommand: "/close pos_001 telegram close",
      recipient: "chat_001",
      notifierGateway: new MockNotifierGateway({
        sendMessage: {
          type: "fail",
          error: new Error("telegram unavailable"),
        },
        sendAlert: {
          type: "success",
          value: {
            delivered: true,
            channel: "telegram",
            recipient: "chat_001",
          },
        },
      }),
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      requestedBy: "operator",
      requestedAt: "2026-04-21T12:00:00.000Z",
    });

    expect(result.command).toBe("REQUEST_CLOSE");
    expect(result.actionId).not.toBeNull();

    const actions = await actionRepository.list();
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe("CLOSE");
    expect(actions[0]?.status).toBe("QUEUED");
  });

  it("sends operator alerts through the notifier gateway", async () => {
    const result = await sendOperatorAlert({
      notifierGateway: new MockNotifierGateway({
        sendMessage: {
          type: "success",
          value: {
            delivered: true,
            channel: "telegram",
            recipient: "chat_001",
          },
        },
        sendAlert: {
          type: "success",
          value: {
            delivered: true,
            channel: "telegram",
            recipient: "chat_001",
          },
        },
      }),
      recipient: "chat_001",
      title: "Meridian Alert",
      body: "Queue is paused",
    });

    expect(result).toEqual({
      delivered: true,
      channel: "telegram",
      recipient: "chat_001",
    });
  });

  it("parses and applies deterministic manual circuit breaker commands", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const runtimeControlStore = new FileRuntimeControlStore({
      filePath: path.join(directory, "runtime-controls.json"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    expect(
      parseOperatorCommand({ raw: "circuit_breaker_trip market panic" }),
    ).toEqual({
      kind: "CIRCUIT_BREAKER_TRIP",
      reason: "market panic",
    });
    expect(parseOperatorCommand({ raw: "circuit_breaker_clear" })).toEqual({
      kind: "CIRCUIT_BREAKER_CLEAR",
    });

    const tripResult = await executeOperatorCommand({
      command: {
        kind: "CIRCUIT_BREAKER_TRIP",
        reason: "market panic",
      },
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      runtimeControlStore,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      requestedBy: "operator",
      requestedAt: "2026-04-21T12:00:00.000Z",
    });

    expect(tripResult.text).toMatch(/activated/i);
    expect((await runtimeControlStore.snapshot()).stopAllDeploys.active).toBe(
      true,
    );

    await expect(
      handleCliOperatorCommand({
        rawCommand: `deploy ${JSON.stringify(buildDeployPayload())}`,
        wallet: "wallet_001",
        actionQueue,
        stateRepository,
        actionRepository,
        journalRepository,
        runtimeControlStore,
        walletGateway: new MockWalletGateway({
          getWalletBalance: {
            type: "success",
            value: {
              wallet: "wallet_001",
              balanceSol: 5,
              asOf: "2026-04-21T12:00:00.000Z",
            },
          },
        }),
        priceGateway: new MockPriceGateway({
          getSolPriceUsd: {
            type: "success",
            value: {
              symbol: "SOL",
              priceUsd: 20,
              asOf: "2026-04-21T12:00:00.000Z",
            },
          },
        }),
        riskPolicy: buildRiskPolicy(),
        requestedBy: "operator",
        requestedAt: "2026-04-21T12:00:00.000Z",
      }),
    ).rejects.toThrow(/manual circuit breaker/i);

    const clearResult = await executeOperatorCommand({
      command: {
        kind: "CIRCUIT_BREAKER_CLEAR",
      },
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository,
      runtimeControlStore,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      requestedBy: "operator",
      requestedAt: "2026-04-21T12:05:00.000Z",
    });

    expect(clearResult.text).toMatch(/cleared/i);
    expect((await runtimeControlStore.snapshot()).stopAllDeploys.active).toBe(
      false,
    );
    expect(
      (await journalRepository.list()).map((event) => event.eventType),
    ).toEqual(
      expect.arrayContaining([
        "CIRCUIT_BREAKER_MANUAL_TRIP",
        "CIRCUIT_BREAKER_MANUAL_CLEAR",
      ]),
    );
  });

  it("keeps manual circuit breaker state changes when journal append fails", async () => {
    const directory = await makeTempDir();
    const stateRepository = new StateRepository({
      filePath: path.join(directory, "positions.json"),
    });
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const runtimeControlStore = new FileRuntimeControlStore({
      filePath: path.join(directory, "runtime-controls.json"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository: new JournalRepository({
        filePath: path.join(directory, "journal.jsonl"),
      }),
    });
    const failingJournalRepository = {
      async append() {
        throw new Error("disk full");
      },
    } as unknown as JournalRepository;

    const tripResult = await executeOperatorCommand({
      command: {
        kind: "CIRCUIT_BREAKER_TRIP",
      },
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository: failingJournalRepository,
      runtimeControlStore,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:00:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      requestedBy: "operator",
      requestedAt: "2026-04-21T12:00:00.000Z",
    });

    expect(tripResult.text).toContain("manual circuit breaker activated");
    expect(tripResult.text).toContain("journal write failed");
    expect((await runtimeControlStore.snapshot()).stopAllDeploys.active).toBe(
      true,
    );

    const clearResult = await executeOperatorCommand({
      command: {
        kind: "CIRCUIT_BREAKER_CLEAR",
      },
      wallet: "wallet_001",
      actionQueue,
      stateRepository,
      actionRepository,
      journalRepository: failingJournalRepository,
      runtimeControlStore,
      walletGateway: new MockWalletGateway({
        getWalletBalance: {
          type: "success",
          value: {
            wallet: "wallet_001",
            balanceSol: 5,
            asOf: "2026-04-21T12:05:00.000Z",
          },
        },
      }),
      priceGateway: new MockPriceGateway({
        getSolPriceUsd: {
          type: "success",
          value: {
            symbol: "SOL",
            priceUsd: 20,
            asOf: "2026-04-21T12:05:00.000Z",
          },
        },
      }),
      riskPolicy: buildRiskPolicy(),
      requestedBy: "operator",
      requestedAt: "2026-04-21T12:05:00.000Z",
    });

    expect(clearResult.text).toContain("manual circuit breaker cleared");
    expect(clearResult.text).toContain("journal write failed");
    expect((await runtimeControlStore.snapshot()).stopAllDeploys.active).toBe(
      false,
    );
  });
});
