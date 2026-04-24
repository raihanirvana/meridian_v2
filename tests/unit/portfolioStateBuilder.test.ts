import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MockPriceGateway } from "../../src/adapters/pricing/PriceGateway.js";
import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { MockWalletGateway } from "../../src/adapters/wallet/WalletGateway.js";
import { buildPortfolioState } from "../../src/app/services/PortfolioStateBuilder.js";
import type { PortfolioSnapshotStaleError } from "../../src/app/services/PortfolioStateBuilder.js";
import { countRecentNewDeploys } from "../../src/app/services/RecentDeployCounter.js";
import { type Action } from "../../src/domain/entities/Action.js";
import { type JournalEvent } from "../../src/domain/entities/JournalEvent.js";
import { type Position } from "../../src/domain/entities/Position.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-b13-"),
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
    currentValueUsd: 40,
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
    status: "DONE",
    wallet: "wallet_001",
    positionId: null,
    idempotencyKey: "wallet_001:DEPLOY:none:abc",
    requestPayload: {
      poolAddress: "pool_new",
    },
    resultPayload: null,
    txIds: [],
    error: null,
    requestedAt: "2026-04-21T11:30:00.000Z",
    startedAt: "2026-04-21T11:30:01.000Z",
    completedAt: "2026-04-21T11:31:00.000Z",
    requestedBy: "system",
    ...overrides,
  };
}

function buildJournalEvent(
  overrides: Partial<JournalEvent> = {},
): JournalEvent {
  return {
    timestamp: "2026-04-21T12:00:00.000Z",
    eventType: "POSITION_UPDATED",
    actor: "system",
    wallet: "wallet_001",
    positionId: "pos_001",
    actionId: "act_001",
    before: null,
    after: null,
    txIds: [],
    resultStatus: "OK",
    error: null,
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

describe("portfolio state builder", () => {
  it("builds a canonical portfolio snapshot from wallet balance, local positions, and pending actions", async () => {
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

    await stateRepository.upsert(buildPosition());
    await stateRepository.upsert(
      buildPosition({
        positionId: "pos_closed",
        status: "CLOSED",
        closedAt: "2026-04-21T05:00:00.000Z",
        openedAt: "2026-04-20T00:00:00.000Z",
        currentValueUsd: 0,
        realizedPnlUsd: -5,
      }),
    );
    await actionRepository.upsert(
      buildAction({
        actionId: "act_pending",
        status: "QUEUED",
        startedAt: null,
        completedAt: null,
      }),
    );
    await journalRepository.append(
      buildJournalEvent({
        positionId: "pos_closed",
        before: buildPosition({
          positionId: "pos_closed",
          status: "OPEN",
          openedAt: "2026-04-20T00:00:00.000Z",
          currentValueUsd: 5,
          realizedPnlUsd: 0,
        }),
        after: buildPosition({
          positionId: "pos_closed",
          status: "CLOSED",
          openedAt: "2026-04-20T00:00:00.000Z",
          closedAt: "2026-04-21T05:00:00.000Z",
          currentValueUsd: 0,
          realizedPnlUsd: -5,
        }),
      }),
    );

    const portfolio = await buildPortfolioState({
      wallet: "wallet_001",
      minReserveUsd: 10,
      dailyLossLimitPct: 8,
      circuitBreakerCooldownMin: 180,
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
      now: "2026-04-21T12:00:00.000Z",
    });

    expect(portfolio.walletBalance).toBe(140);
    expect(portfolio.reservedBalance).toBe(10);
    expect(portfolio.availableBalance).toBe(90);
    expect(portfolio.openPositions).toBe(1);
    expect(portfolio.pendingActions).toBe(1);
    expect(portfolio.dailyRealizedPnl).toBe(-5);
    expect(portfolio.drawdownState).toBe("NORMAL");
    expect(portfolio.circuitBreakerState).toBe("OFF");
    expect(portfolio.exposureByPool.pool_001).toBeCloseTo(28.5714, 3);
    expect(portfolio.exposureByToken.mint_x).toBeCloseTo(28.5714, 3);
    expect(portfolio.exposureByToken.mint_base).toBeCloseTo(28.5714, 3);
  });

  it("keeps reconciliation-required capital visible in the portfolio snapshot", async () => {
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

    await stateRepository.upsert(
      buildPosition({
        positionId: "pos_reconcile",
        status: "RECONCILIATION_REQUIRED",
        currentValueUsd: 30,
        needsReconciliation: true,
      }),
    );

    const portfolio = await buildPortfolioState({
      wallet: "wallet_001",
      minReserveUsd: 10,
      dailyLossLimitPct: 8,
      circuitBreakerCooldownMin: 180,
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
      now: "2026-04-21T12:00:00.000Z",
    });

    expect(portfolio.walletBalance).toBe(130);
    expect(portfolio.openPositions).toBe(1);
    expect(portfolio.exposureByPool.pool_001).toBeCloseTo(23.0769, 3);
  });

  it("enters cooldown when loss recovers below the limit after a previous breaker ON snapshot", async () => {
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

    const portfolio = await buildPortfolioState({
      wallet: "wallet_001",
      minReserveUsd: 10,
      dailyLossLimitPct: 8,
      circuitBreakerCooldownMin: 180,
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
      previousPortfolioState: {
        walletBalance: 100,
        reservedBalance: 10,
        availableBalance: 90,
        openPositions: 0,
        pendingActions: 0,
        dailyRealizedPnl: -10,
        drawdownState: "LIMIT_REACHED",
        circuitBreakerState: "ON",
        exposureByToken: {},
        exposureByPool: {},
      },
      now: "2026-04-21T12:00:00.000Z",
    });

    expect(portfolio.circuitBreakerState).toBe("COOLDOWN");
    expect(portfolio.circuitBreakerCooldownStartedAt).toBe(
      "2026-04-21T12:00:00.000Z",
    );
  });

  it("expires cooldown back to OFF after the configured cooldown window elapses", async () => {
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

    const portfolio = await buildPortfolioState({
      wallet: "wallet_001",
      minReserveUsd: 10,
      dailyLossLimitPct: 8,
      circuitBreakerCooldownMin: 60,
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
      previousPortfolioState: {
        walletBalance: 100,
        reservedBalance: 10,
        availableBalance: 90,
        openPositions: 0,
        pendingActions: 0,
        dailyRealizedPnl: -1,
        drawdownState: "WARNING",
        circuitBreakerState: "COOLDOWN",
        circuitBreakerActivatedAt: "2026-04-21T10:00:00.000Z",
        circuitBreakerCooldownStartedAt: "2026-04-21T10:30:00.000Z",
        exposureByToken: {},
        exposureByPool: {},
      },
      now: "2026-04-21T12:00:00.000Z",
    });

    expect(portfolio.circuitBreakerState).toBe("OFF");
    expect(portfolio.circuitBreakerCooldownStartedAt).toBeNull();
  });

  it("derives daily realized pnl from journal deltas so prior-day realized amounts are not overcounted", async () => {
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

    const openPosition = buildPosition({
      positionId: "pos_partial",
      realizedPnlUsd: 3,
    });
    const closedPosition = buildPosition({
      positionId: "pos_closed",
      status: "CLOSED",
      openedAt: "2026-04-20T00:00:00.000Z",
      closedAt: "2026-04-21T12:00:00.000Z",
      currentValueUsd: 0,
      realizedPnlUsd: 8,
    });

    await stateRepository.upsert(openPosition);
    await stateRepository.upsert(closedPosition);
    await journalRepository.append(
      buildJournalEvent({
        positionId: "pos_partial",
        before: buildPosition({
          positionId: "pos_partial",
          realizedPnlUsd: 0,
        }),
        after: openPosition,
      }),
    );
    await journalRepository.append(
      buildJournalEvent({
        positionId: "pos_closed",
        before: buildPosition({
          positionId: "pos_closed",
          status: "OPEN",
          openedAt: "2026-04-20T00:00:00.000Z",
          realizedPnlUsd: 3,
          currentValueUsd: 5,
        }),
        after: closedPosition,
      }),
    );

    const portfolio = await buildPortfolioState({
      wallet: "wallet_001",
      minReserveUsd: 10,
      dailyLossLimitPct: 8,
      circuitBreakerCooldownMin: 180,
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
      now: "2026-04-21T12:00:00.000Z",
    });

    expect(portfolio.dailyRealizedPnl).toBe(8);
  });

  it("rejects stale wallet snapshots instead of building a portfolio from outdated balances", async () => {
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

    await expect(
      buildPortfolioState({
        wallet: "wallet_001",
        minReserveUsd: 10,
        dailyLossLimitPct: 8,
        circuitBreakerCooldownMin: 180,
        stateRepository,
        actionRepository,
        journalRepository,
        walletGateway: new MockWalletGateway({
          getWalletBalance: {
            type: "success",
            value: {
              wallet: "wallet_001",
              balanceSol: 5,
              asOf: "2026-04-21T11:00:00.000Z",
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
        now: "2026-04-21T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      name: "PortfolioSnapshotStaleError",
      source: "wallet",
    } satisfies Partial<PortfolioSnapshotStaleError>);
  });

  it("rejects stale SOL price snapshots instead of building a portfolio from outdated valuation", async () => {
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

    await expect(
      buildPortfolioState({
        wallet: "wallet_001",
        minReserveUsd: 10,
        dailyLossLimitPct: 8,
        circuitBreakerCooldownMin: 180,
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
              asOf: "2026-04-21T11:00:00.000Z",
            },
          },
        }),
        now: "2026-04-21T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      name: "PortfolioSnapshotStaleError",
      source: "price",
    } satisfies Partial<PortfolioSnapshotStaleError>);
  });

  it("counts recent deploys from the last hour using deploy actions only", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });

    await actionRepository.upsert(
      buildAction({
        actionId: "act_recent_deploy",
        requestedAt: "2026-04-21T11:30:00.000Z",
      }),
    );
    await actionRepository.upsert(
      buildAction({
        actionId: "act_old_deploy",
        requestedAt: "2026-04-21T09:30:00.000Z",
      }),
    );
    await actionRepository.upsert(
      buildAction({
        actionId: "act_failed_deploy",
        requestedAt: "2026-04-21T11:45:00.000Z",
        status: "FAILED",
      }),
    );
    await actionRepository.upsert(
      buildAction({
        actionId: "act_recent_rebalance",
        type: "REBALANCE",
        positionId: "pos_001",
        idempotencyKey: "wallet_001:REBALANCE:pos_001:def",
        requestedAt: "2026-04-21T11:50:00.000Z",
      }),
    );

    await expect(
      countRecentNewDeploys({
        wallet: "wallet_001",
        actionRepository,
        now: "2026-04-21T12:00:00.000Z",
      }),
    ).resolves.toBe(1);
  });
});
