import { describe, expect, it } from "vitest";

import {
  canTransitionPositionStatus,
  transitionRebalancePositionStatus,
  transitionPositionStatus,
} from "../../src/domain/stateMachines/positionLifecycle.js";
import {
  PositionSchema,
  type Position,
} from "../../src/domain/entities/Position.js";

function buildPositionLike() {
  return {
    positionId: "pos_001",
    poolAddress: "pool_001",
    tokenXMint: "mint_x",
    tokenYMint: "mint_y",
    baseMint: "mint_base",
    quoteMint: "mint_quote",
    wallet: "wallet_001",
    status: "OPEN" as const,
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
    strategy: "bid_ask" as const,
    rangeLowerBin: 10,
    rangeUpperBin: 20,
    activeBin: 15,
    outOfRangeSince: null,
    lastManagementDecision: null,
    lastManagementReason: null,
    lastWriteActionId: null,
    needsReconciliation: false,
  };
}

describe("positionLifecycle", () => {
  it("supports the close path from OPEN to CLOSED", () => {
    let status: Position["status"] = "OPEN";

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
    let status: Position["status"] = "OPEN";

    status = transitionPositionStatus(status, "MANAGEMENT_REVIEW");
    status = transitionPositionStatus(status, "REBALANCE_REQUESTED");
    status = transitionPositionStatus(status, "CLOSING_FOR_REBALANCE");
    status = transitionPositionStatus(status, "CLOSE_CONFIRMED");
    status = transitionRebalancePositionStatus(status, "REDEPLOY_REQUESTED");
    status = transitionPositionStatus(status, "REDEPLOYING");
    status = transitionPositionStatus(status, "OPEN");

    expect(status).toBe("OPEN");
  });

  it("requires rebalance context before redeploying from CLOSE_CONFIRMED", () => {
    expect(
      canTransitionPositionStatus("CLOSE_CONFIRMED", "REDEPLOY_REQUESTED"),
    ).toBe(false);
    expect(() =>
      transitionPositionStatus("CLOSE_CONFIRMED", "REDEPLOY_REQUESTED"),
    ).toThrow(/Invalid position transition/i);
    expect(
      canTransitionPositionStatus("CLOSE_CONFIRMED", "REDEPLOY_REQUESTED", {
        flow: "rebalance",
      }),
    ).toBe(true);
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

  it("rejects invalid position strategy values", () => {
    const result = PositionSchema.safeParse({
      positionId: "pos_bad_strategy",
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
      strategy: "martingale",
      rangeLowerBin: 10,
      rangeUpperBin: 20,
      activeBin: 15,
      outOfRangeSince: null,
      lastManagementDecision: null,
      lastManagementReason: null,
      lastWriteActionId: null,
      needsReconciliation: false,
    });

    expect(result.success).toBe(false);
  });

  it("rejects direct CLOSE_CONFIRMED to CLOSED transition", () => {
    expect(canTransitionPositionStatus("CLOSE_CONFIRMED", "CLOSED")).toBe(
      false,
    );
    expect(() => transitionPositionStatus("CLOSE_CONFIRMED", "CLOSED")).toThrow(
      /Invalid position transition/i,
    );
  });

  it("rejects direct OPEN to ABORTED transition without an escalation reason", () => {
    expect(canTransitionPositionStatus("OPEN", "ABORTED")).toBe(false);
    expect(() => transitionPositionStatus("OPEN", "ABORTED")).toThrow(
      /requires an explicit escalationReason/i,
    );
  });

  it("allows direct ABORTED transition when an escalation reason is provided", () => {
    expect(
      canTransitionPositionStatus("OPEN", "ABORTED", {
        escalationReason: "operator_abort",
      }),
    ).toBe(true);
    expect(
      transitionPositionStatus("OPEN", "ABORTED", {
        escalationReason: "startup_recovery",
      }),
    ).toBe("ABORTED");
  });

  it("rejects peakPnlPct with a null peakPnlRecordedAt timestamp", () => {
    const result = PositionSchema.safeParse({
      ...buildPositionLike(),
      peakPnlPct: 10,
      peakPnlRecordedAt: null,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a peakPnlRecordedAt timestamp when peakPnlPct is unset", () => {
    const result = PositionSchema.safeParse({
      ...buildPositionLike(),
      peakPnlPct: null,
      peakPnlRecordedAt: "2026-04-18T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("allows direct FAILED transition only with an escalation reason", () => {
    expect(canTransitionPositionStatus("OPEN", "FAILED")).toBe(false);
    expect(
      canTransitionPositionStatus("OPEN", "FAILED", {
        escalationReason: "fatal_validation",
      }),
    ).toBe(true);
  });

  it("still allows direct RECONCILIATION_REQUIRED escalation without a reason", () => {
    expect(canTransitionPositionStatus("OPEN", "RECONCILIATION_REQUIRED")).toBe(
      true,
    );
  });

  it("does not require escalation reason for transitions allowed by the base table", () => {
    expect(canTransitionPositionStatus("DEPLOY_REQUESTED", "FAILED")).toBe(
      true,
    );
    expect(canTransitionPositionStatus("DEPLOYING", "ABORTED")).toBe(true);
  });

  it("rejects positions in an active status that are missing openedAt", () => {
    const result = PositionSchema.safeParse({
      positionId: "pos_active",
      poolAddress: "pool_001",
      tokenXMint: "mint_x",
      tokenYMint: "mint_y",
      baseMint: "mint_base",
      quoteMint: "mint_quote",
      wallet: "wallet_001",
      status: "MANAGEMENT_REVIEW",
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

    expect(result.success).toBe(false);
  });

  it("rejects out-of-range positions that have a null outOfRangeSince", () => {
    const result = PositionSchema.safeParse({
      positionId: "pos_oor",
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
      activeBin: 25,
      outOfRangeSince: null,
      lastManagementDecision: null,
      lastManagementReason: null,
      lastWriteActionId: null,
      needsReconciliation: false,
    });

    expect(result.success).toBe(false);
  });

  it("rejects RECONCILIATION_REQUIRED status with needsReconciliation=false", () => {
    const result = PositionSchema.safeParse({
      positionId: "pos_recon",
      poolAddress: "pool_001",
      tokenXMint: "mint_x",
      tokenYMint: "mint_y",
      baseMint: "mint_base",
      quoteMint: "mint_quote",
      wallet: "wallet_001",
      status: "RECONCILIATION_REQUIRED",
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

    expect(result.success).toBe(false);
  });

  it("allows in-range positions to carry stale outOfRangeSince for later management cleanup", () => {
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

    expect(result.success).toBe(true);
  });
});
