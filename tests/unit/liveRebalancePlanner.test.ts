import { describe, expect, it } from "vitest";

import { resolveLiveRedeployAmounts } from "../../src/runtime/liveRebalancePlanner.js";
import type { Position } from "../../src/domain/entities/Position.js";

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
    openedAt: "2026-04-20T00:00:00.000Z",
    lastSyncedAt: "2026-04-20T00:00:00.000Z",
    closedAt: null,
    deployAmountBase: 1,
    deployAmountQuote: 0.5,
    currentValueBase: 1.2,
    currentValueUsd: 120,
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

describe("live rebalance planner helpers", () => {
  it("uses hydrated current quote amount when available", () => {
    expect(
      resolveLiveRedeployAmounts(
        buildPosition({
          currentValueQuote: 0.7,
          deployAmountQuote: 0.5,
        }),
      ),
    ).toEqual({
      amountBase: 1.2,
      amountQuote: 0.7,
    });
  });

  it("falls back to deploy quote amount for positions without hydrated currentValueQuote", () => {
    expect(resolveLiveRedeployAmounts(buildPosition())).toEqual({
      amountBase: 1.2,
      amountQuote: 0.5,
    });
  });
});
