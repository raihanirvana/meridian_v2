import { describe, expect, it } from "vitest";

import {
  canTransitionPositionStatus,
  transitionPositionStatus,
} from "../../src/domain/stateMachines/positionLifecycle.js";
import { PositionSchema } from "../../src/domain/entities/Position.js";

describe("positionLifecycle", () => {
  it("supports the close path from OPEN to CLOSED", () => {
    let status = "OPEN" as const;

    status = transitionPositionStatus(status, "MANAGEMENT_REVIEW");
    status = transitionPositionStatus(status, "CLOSE_REQUESTED");
    status = transitionPositionStatus(status, "CLOSING");
    status = transitionPositionStatus(status, "CLOSE_CONFIRMED");
    status = transitionPositionStatus(status, "RECONCILING");
    status = transitionPositionStatus(status, "CLOSED");

    expect(status).toBe("CLOSED");
  });

  it("rejects invalid direct transition from OPEN to CLOSED", () => {
    expect(canTransitionPositionStatus("OPEN", "CLOSED")).toBe(false);
    expect(() => transitionPositionStatus("OPEN", "CLOSED")).toThrow(
      /Invalid position transition/i,
    );
  });

  it("supports the rebalance path", () => {
    let status = "OPEN" as const;

    status = transitionPositionStatus(status, "MANAGEMENT_REVIEW");
    status = transitionPositionStatus(status, "REBALANCE_REQUESTED");
    status = transitionPositionStatus(status, "CLOSING_FOR_REBALANCE");
    status = transitionPositionStatus(status, "CLOSE_CONFIRMED");
    status = transitionPositionStatus(status, "REDEPLOY_REQUESTED");
    status = transitionPositionStatus(status, "REDEPLOYING");
    status = transitionPositionStatus(status, "OPEN");

    expect(status).toBe("OPEN");
  });

  it("parses a position entity with official lifecycle status", () => {
    const result = PositionSchema.safeParse({
      positionId: "pos_001",
      poolAddress: "pool_001",
      tokenXMint: "mint_x",
      tokenYMint: "mint_y",
      baseMint: "mint_base",
      quoteMint: "mint_quote",
      wallet: "wallet_001",
      status: "DEPLOY_REQUESTED",
      openedAt: null,
      lastSyncedAt: "2026-04-18T00:00:00.000Z",
      closedAt: null,
      deployAmountBase: 1,
      deployAmountQuote: 0.5,
      currentValueBase: 1,
      currentValueUsd: 100,
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
    });

    expect(result.success).toBe(true);
  });

  it("rejects direct CLOSE_CONFIRMED to CLOSED transition", () => {
    expect(canTransitionPositionStatus("CLOSE_CONFIRMED", "CLOSED")).toBe(false);
    expect(() => transitionPositionStatus("CLOSE_CONFIRMED", "CLOSED")).toThrow(
      /Invalid position transition/i,
    );
  });

  it("rejects in-range positions that still carry outOfRangeSince", () => {
    const result = PositionSchema.safeParse({
      positionId: "pos_002",
      poolAddress: "pool_001",
      tokenXMint: "mint_x",
      tokenYMint: "mint_y",
      baseMint: "mint_base",
      quoteMint: "mint_quote",
      wallet: "wallet_001",
      status: "OPEN",
      openedAt: "2026-04-18T00:00:00.000Z",
      lastSyncedAt: "2026-04-18T00:00:00.000Z",
      closedAt: null,
      deployAmountBase: 1,
      deployAmountQuote: 0.5,
      currentValueBase: 1,
      currentValueUsd: 100,
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
      outOfRangeSince: "2026-04-18T01:00:00.000Z",
      lastManagementDecision: null,
      lastManagementReason: null,
      lastWriteActionId: null,
      needsReconciliation: false,
    });

    expect(result.success).toBe(false);
  });
});
