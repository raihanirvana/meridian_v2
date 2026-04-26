import { describe, expect, it } from "vitest";

import {
  evaluateManagementAction,
  ManagementPolicySchema,
} from "../../src/domain/rules/managementRules.js";
import { type PortfolioState } from "../../src/domain/entities/PortfolioState.js";
import { type Position } from "../../src/domain/entities/Position.js";

function buildOpenPosition(overrides: Partial<Position> = {}): Position {
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
    ...overrides,
  };
}

function buildPortfolio(
  overrides: Partial<PortfolioState> = {},
): PortfolioState {
  return {
    walletBalance: 10,
    reservedBalance: 1,
    availableBalance: 9,
    openPositions: 1,
    pendingActions: 0,
    dailyRealizedPnl: 0,
    drawdownState: "NORMAL",
    circuitBreakerState: "OFF",
    exposureByToken: {},
    exposureByPool: {},
    ...overrides,
  };
}

function buildInput(overrides?: {
  now?: string;
  position?: Partial<Position>;
  portfolio?: Partial<PortfolioState>;
  signals?: Partial<{
    forcedManualClose: boolean;
    severeTokenRisk: boolean;
    liquidityCollapse: boolean;
    severeNegativeYield: boolean;
    claimableFeesUsd: number;
    expectedRebalanceImprovement: boolean;
    dataIncomplete: boolean;
  }>;
  policy?: Partial<{
    stopLossUsd: number;
    maxHoldMinutes: number;
    maxOutOfRangeMinutes: number;
    trailingTakeProfitEnabled: boolean;
    trailingTriggerPct: number;
    trailingDropPct: number;
    claimFeesThresholdUsd: number;
    partialCloseEnabled: boolean;
    partialCloseProfitTargetUsd: number;
    rebalanceEnabled: boolean;
    maxRebalancesPerPosition: number;
  }>;
}) {
  return {
    now: overrides?.now ?? "2026-04-20T01:00:00.000Z",
    position: buildOpenPosition(overrides?.position),
    portfolio: buildPortfolio(overrides?.portfolio),
    signals: {
      forcedManualClose: false,
      severeTokenRisk: false,
      liquidityCollapse: false,
      severeNegativeYield: false,
      claimableFeesUsd: 0,
      expectedRebalanceImprovement: false,
      dataIncomplete: false,
      ...overrides?.signals,
    },
    policy: {
      stopLossUsd: 20,
      maxHoldMinutes: 1_440,
      maxOutOfRangeMinutes: 60,
      trailingTakeProfitEnabled: false,
      trailingTriggerPct: 3,
      trailingDropPct: 1.5,
      claimFeesThresholdUsd: 10,
      partialCloseEnabled: true,
      partialCloseProfitTargetUsd: 25,
      rebalanceEnabled: true,
      maxRebalancesPerPosition: 2,
      ...overrides?.policy,
    },
  };
}

describe("management rules", () => {
  it("makes stop loss outrank claim fees", () => {
    const result = evaluateManagementAction(
      buildInput({
        position: {
          unrealizedPnlUsd: -25,
        },
        signals: {
          claimableFeesUsd: 50,
        },
      }),
    );

    expect(result.action).toBe("CLOSE");
    expect(result.priority).toBe("HARD_EXIT");
    expect(result.triggerReasons.join(" ")).toMatch(/stop loss/i);
  });

  it("makes hard exit outrank rebalance", () => {
    const result = evaluateManagementAction(
      buildInput({
        position: {
          outOfRangeSince: "2026-04-19T22:00:00.000Z",
          activeBin: 25,
        },
        signals: {
          expectedRebalanceImprovement: true,
        },
      }),
    );

    expect(result.action).toBe("CLOSE");
    expect(result.priority).toBe("HARD_EXIT");
  });

  it("returns HOLD when all management checks are safe", () => {
    const result = evaluateManagementAction(buildInput());

    expect(result.action).toBe("HOLD");
    expect(result.priority).toBe("HOLD");
    expect(result.triggerReasons).toEqual([
      "all management checks are currently safe",
    ]);
  });

  it("never returns partial close and rebalance together, partial close wins first", () => {
    const result = evaluateManagementAction(
      buildInput({
        position: {
          unrealizedPnlUsd: 40,
          activeBin: 25,
          outOfRangeSince: "2026-04-20T00:30:00.000Z",
        },
        signals: {
          expectedRebalanceImprovement: true,
        },
      }),
    );

    expect(result.action).toBe("PARTIAL_CLOSE");
    expect(result.priority).toBe("MAINTENANCE_PARTIAL_CLOSE");
  });

  it("returns RECONCILE_ONLY when the management snapshot is incomplete", () => {
    const result = evaluateManagementAction(
      buildInput({
        signals: {
          dataIncomplete: true,
          claimableFeesUsd: 100,
        },
      }),
    );

    expect(result.action).toBe("RECONCILE_ONLY");
    expect(result.priority).toBe("RECONCILE_ONLY");
  });

  it("returns RECONCILE_ONLY when the position itself is flagged for reconciliation", () => {
    const result = evaluateManagementAction(
      buildInput({
        position: {
          needsReconciliation: true,
        },
      }),
    );

    expect(result.action).toBe("RECONCILE_ONLY");
    expect(result.triggerReasons).toEqual([
      "position.needsReconciliation is true",
    ]);
  });

  it("returns REBALANCE when maintenance rebalance conditions are satisfied", () => {
    const result = evaluateManagementAction(
      buildInput({
        position: {
          activeBin: 25,
          outOfRangeSince: "2026-04-20T00:30:00.000Z",
        },
        signals: {
          expectedRebalanceImprovement: true,
        },
      }),
    );

    expect(result.action).toBe("REBALANCE");
    expect(result.priority).toBe("MAINTENANCE_REBALANCE");
  });

  it("returns CLOSE when trailing take profit retraces from persisted peak", () => {
    const result = evaluateManagementAction(
      buildInput({
        position: {
          currentValueUsd: 107,
          unrealizedPnlUsd: 7,
          peakPnlPct: 12,
          peakPnlRecordedAt: "2026-04-20T00:30:00.000Z",
        },
        policy: {
          trailingTakeProfitEnabled: true,
          trailingTriggerPct: 8,
          trailingDropPct: 3,
          claimFeesThresholdUsd: 999,
          partialCloseEnabled: false,
        },
      }),
    );

    expect(result.action).toBe("CLOSE");
    expect(result.reason).toMatch(/trailing take profit/i);
  });

  it("lets trailing take profit outrank reconcile-only when it is configured as hard exit", () => {
    const result = evaluateManagementAction(
      buildInput({
        position: {
          currentValueUsd: 107,
          unrealizedPnlUsd: 7,
          peakPnlPct: 12,
          peakPnlRecordedAt: "2026-04-20T00:30:00.000Z",
        },
        signals: {
          dataIncomplete: true,
        },
        policy: {
          trailingTakeProfitEnabled: true,
          trailingTriggerPct: 8,
          trailingDropPct: 3,
          claimFeesThresholdUsd: 999,
          partialCloseEnabled: false,
        },
      }),
    );

    expect(result.action).toBe("CLOSE");
    expect(result.priority).toBe("HARD_EXIT");
    expect(result.reason).toMatch(/trailing take profit/i);
  });

  it("treats zero thresholds as disabled for stop loss, claim fees, and partial close", () => {
    const result = evaluateManagementAction(
      buildInput({
        position: {
          unrealizedPnlUsd: 0,
        },
        signals: {
          claimableFeesUsd: 0,
        },
        policy: {
          stopLossUsd: 0,
          claimFeesThresholdUsd: 0,
          partialCloseProfitTargetUsd: 0,
        },
      }),
    );

    expect(result.action).toBe("HOLD");
  });

  it("rejects non-OPEN positions at the schema boundary", () => {
    expect(() =>
      evaluateManagementAction(
        buildInput({
          position: {
            status: "HOLD",
            openedAt: null,
          } as Partial<Position>,
        }),
      ),
    ).toThrow(/only accepts OPEN positions/i);
  });

  it("rejects trailing take profit config when enabled without positive thresholds", () => {
    expect(() =>
      ManagementPolicySchema.parse({
        ...buildInput().policy,
        trailingTakeProfitEnabled: true,
        trailingTriggerPct: 0,
        trailingDropPct: 0,
      }),
    ).toThrow(/trailing/i);
  });
});
