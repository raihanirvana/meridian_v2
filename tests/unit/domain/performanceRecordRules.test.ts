import { describe, expect, it } from "vitest";

import type { Action } from "../../../src/domain/entities/Action.js";
import type { Position } from "../../../src/domain/entities/Position.js";
import { buildPerformanceRecordFromClosedPosition } from "../../../src/domain/rules/performanceRecordRules.js";

const closedAt = "2026-04-20T01:00:00.000Z";

function buildAction(): Action {
  return {
    actionId: "act_close_001",
    type: "CLOSE",
    status: "DONE",
    wallet: "wallet_001",
    positionId: "pos_001",
    idempotencyKey: "close_key",
    requestPayload: { reason: "manual" },
    resultPayload: null,
    txIds: ["tx_close"],
    error: null,
    requestedAt: "2026-04-20T00:59:00.000Z",
    startedAt: "2026-04-20T00:59:01.000Z",
    completedAt: closedAt,
    requestedBy: "system",
  };
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
    status: "CLOSED",
    openedAt: "2026-04-20T00:00:00.000Z",
    lastSyncedAt: closedAt,
    closedAt,
    deployAmountBase: 1,
    deployAmountQuote: 0.5,
    currentValueBase: 0,
    currentValueQuote: 0,
    currentValueUsd: 100,
    feesClaimedBase: 0,
    feesClaimedUsd: 5,
    realizedPnlBase: 0,
    realizedPnlUsd: 10,
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
    lastWriteActionId: "act_close_001",
    needsReconciliation: false,
    entryMetadata: {
      poolName: "SOL-USDC",
      binStep: 100,
      volatility: 12,
      feeTvlRatio: 0.2,
      organicScore: 80,
      amountSol: 1.5,
    },
    ...overrides,
  };
}

describe("performanceRecordRules", () => {
  it("builds a record from profitable finalized close accounting", () => {
    const result = buildPerformanceRecordFromClosedPosition({
      position: buildPosition(),
      closedAction: buildAction(),
      closeReason: "manual",
      finalValueUsd: 110,
      feesEarnedUsd: 5,
      pnlUsd: 10,
      pnlPct: 10,
      minutesHeld: 60,
      minutesInRange: 60,
      recordedAt: closedAt,
    });

    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.record.pnlUsd).toBe(10);
      expect(result.record.pnlPct).toBe(10);
      expect(result.record.rangeEfficiencyPct).toBe(100);
    }
  });

  it("rejects invalid cost basis when deploy amount exists", () => {
    const result = buildPerformanceRecordFromClosedPosition({
      position: buildPosition({ currentValueUsd: 0 }),
      closedAction: buildAction(),
      closeReason: "manual",
      finalValueUsd: 0,
      feesEarnedUsd: 0,
      pnlUsd: 0,
      pnlPct: 0,
      minutesHeld: 60,
      minutesInRange: 60,
      recordedAt: closedAt,
    });

    expect(result).toEqual({
      skipped: true,
      reason: "invalid_cost_basis",
    });
  });

  it("clamps range efficiency and minutes held", () => {
    const result = buildPerformanceRecordFromClosedPosition({
      position: buildPosition(),
      closedAction: buildAction(),
      closeReason: "manual",
      finalValueUsd: 110,
      feesEarnedUsd: 5,
      pnlUsd: 10,
      pnlPct: 10,
      minutesHeld: -5,
      minutesInRange: 999,
      recordedAt: closedAt,
    });

    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.record.minutesHeld).toBe(0);
      expect(result.record.minutesInRange).toBe(0);
      expect(result.record.rangeEfficiencyPct).toBe(100);
    }
  });
});
