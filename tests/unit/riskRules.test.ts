import { describe, expect, it } from "vitest";

import {
  PortfolioStateSchema,
  type PortfolioState,
} from "../../src/domain/entities/PortfolioState.js";
import { type Position } from "../../src/domain/entities/Position.js";
import {
  buildPortfolioRiskStateSnapshot,
  calculateCapitalUsage,
  evaluatePortfolioRisk,
  projectExposureByPool,
  projectExposureByToken,
  updatePortfolioDailyRiskState,
  type PortfolioRiskPolicy,
} from "../../src/domain/rules/riskRules.js";

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

function buildPolicy(
  overrides: Partial<PortfolioRiskPolicy> = {},
): PortfolioRiskPolicy {
  return {
    maxConcurrentPositions: 3,
    maxCapitalUsagePct: 80,
    minReserveUsd: 1,
    maxTokenExposurePct: 45,
    maxPoolExposurePct: 35,
    maxRebalancesPerPosition: 2,
    dailyLossLimitPct: 10,
    circuitBreakerCooldownMin: 60,
    maxNewDeploysPerHour: 3,
    ...overrides,
  };
}

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
    rebalanceCount: 1,
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

describe("risk rules", () => {
  it("rejects impossible portfolio balance snapshots", () => {
    const result = PortfolioStateSchema.safeParse(
      buildPortfolio({
        walletBalance: 100,
        reservedBalance: 80,
        availableBalance: 80,
      }),
    );

    expect(result.success).toBe(false);
  });

  it("blocks new deploys when daily loss limit is reached but still allows close and reconcile-only actions", () => {
    const portfolio = buildPortfolio({
      dailyRealizedPnl: -1.2,
    });
    const policy = buildPolicy({
      dailyLossLimitPct: 10,
    });

    const deployResult = evaluatePortfolioRisk({
      action: "DEPLOY",
      portfolio,
      policy,
      proposedAllocationUsd: 2,
      proposedPoolAddress: "pool_new",
      proposedTokenMints: ["mint_a", "mint_b"],
      recentNewDeploys: 0,
    });
    const closeResult = evaluatePortfolioRisk({
      action: "CLOSE",
      portfolio,
      policy,
    });
    const reconcileResult = evaluatePortfolioRisk({
      action: "RECONCILE_ONLY",
      portfolio,
      policy,
    });

    expect(deployResult.allowed).toBe(false);
    expect(deployResult.blockingRules.join(" ")).toMatch(
      /daily realized loss/i,
    );
    expect(closeResult.allowed).toBe(true);
    expect(reconcileResult.allowed).toBe(true);
  });

  it("blocks risk-reducing write actions while another write action is pending", () => {
    const portfolio = buildPortfolio({
      pendingActions: 1,
      circuitBreakerState: "ON",
      dailyRealizedPnl: -5,
    });
    const policy = buildPolicy({
      dailyLossLimitPct: 10,
    });

    const closeResult = evaluatePortfolioRisk({
      action: "CLOSE",
      portfolio,
      policy,
    });
    const claimResult = evaluatePortfolioRisk({
      action: "CLAIM_FEES",
      portfolio,
      policy,
    });
    const partialCloseResult = evaluatePortfolioRisk({
      action: "PARTIAL_CLOSE",
      portfolio,
      policy,
    });
    const reconcileResult = evaluatePortfolioRisk({
      action: "RECONCILE_ONLY",
      portfolio,
      policy,
    });

    expect(closeResult.allowed).toBe(false);
    expect(claimResult.allowed).toBe(false);
    expect(partialCloseResult.allowed).toBe(false);
    expect(closeResult.blockingRules).toContain(
      "wallet already has an active write action",
    );
    expect(reconcileResult.allowed).toBe(true);
  });

  it("allows risk-reducing write actions through circuit breaker when no write action is pending", () => {
    const result = evaluatePortfolioRisk({
      action: "CLAIM_FEES",
      portfolio: buildPortfolio({
        circuitBreakerState: "ON",
        dailyRealizedPnl: -5,
      }),
      policy: buildPolicy({
        dailyLossLimitPct: 10,
      }),
    });

    expect(result.allowed).toBe(true);
    expect(result.blockingRules).toEqual([]);
  });

  it("blocks deploy when projected pool exposure exceeds the maximum", () => {
    const result = evaluatePortfolioRisk({
      action: "DEPLOY",
      portfolio: buildPortfolio({
        exposureByPool: {
          pool_hot: 30,
        },
      }),
      policy: buildPolicy({
        maxPoolExposurePct: 35,
      }),
      proposedAllocationUsd: 1,
      proposedPoolAddress: "pool_hot",
      proposedTokenMints: ["mint_a", "mint_b"],
      recentNewDeploys: 0,
    });

    expect(result.allowed).toBe(false);
    expect(result.blockingRules).toContain(
      "projected pool exposure reaches or exceeds maximum",
    );
  });

  it("blocks rebalance when projected token exposure exceeds the maximum", () => {
    const result = evaluatePortfolioRisk({
      action: "REBALANCE",
      portfolio: buildPortfolio({
        exposureByToken: {
          mint_hot: 40,
        },
      }),
      policy: buildPolicy({
        maxTokenExposurePct: 45,
      }),
      proposedAllocationUsd: 1,
      proposedPoolAddress: "pool_alt",
      proposedTokenMints: ["mint_hot", "mint_b"],
      recentNewDeploys: 0,
      position: buildOpenPosition(),
    });

    expect(result.allowed).toBe(false);
    expect(result.blockingRules.join(" ")).toMatch(/mint_hot/i);
  });

  it("blocks deploy when reserve balance would be breached", () => {
    const result = evaluatePortfolioRisk({
      action: "DEPLOY",
      portfolio: buildPortfolio({
        reservedBalance: 0.5,
      }),
      policy: buildPolicy({
        minReserveUsd: 1,
      }),
      proposedAllocationUsd: 1,
      proposedPoolAddress: "pool_new",
      proposedTokenMints: ["mint_a", "mint_b"],
      recentNewDeploys: 0,
    });

    expect(result.allowed).toBe(false);
    expect(result.blockingRules).toContain(
      "minimum reserve balance would be breached",
    );
  });

  it("blocks deploy when the circuit breaker is active", () => {
    const result = evaluatePortfolioRisk({
      action: "DEPLOY",
      portfolio: buildPortfolio({
        circuitBreakerState: "ON",
      }),
      policy: buildPolicy(),
      proposedAllocationUsd: 1,
      proposedPoolAddress: "pool_new",
      proposedTokenMints: ["mint_a", "mint_b"],
      recentNewDeploys: 0,
    });

    expect(result.allowed).toBe(false);
    expect(result.blockingRules.join(" ")).toMatch(/circuit breaker/i);
  });

  it("calculates capital usage and derived risk state deterministically", () => {
    const capital = calculateCapitalUsage({
      walletBalance: 10,
      reservedBalance: 1,
      availableBalance: 3,
      allocationDeltaUsd: 1,
    });
    const state = buildPortfolioRiskStateSnapshot({
      portfolio: buildPortfolio({
        availableBalance: 3,
        dailyRealizedPnl: -0.6,
      }),
      policy: buildPolicy({
        dailyLossLimitPct: 10,
      }),
      allocationDeltaUsd: 1,
    });

    expect(capital.committedCapitalUsd).toBe(6);
    expect(capital.deployableCapitalUsd).toBe(3);
    expect(capital.currentCapitalUsagePct).toBe(60);
    expect(capital.projectedCapitalUsagePct).toBe(70);
    expect(state.drawdownState).toBe("WARNING");
    expect(state.circuitBreakerState).toBe("OFF");
  });

  it("treats rebalance as replacement, not additive exposure/capital", () => {
    const result = evaluatePortfolioRisk({
      action: "REBALANCE",
      portfolio: buildPortfolio({
        availableBalance: 1,
        exposureByPool: {
          pool_old: 40,
        },
        exposureByToken: {
          mint_x: 40,
          mint_y: 40,
        },
      }),
      policy: buildPolicy({
        maxCapitalUsagePct: 90,
        maxPoolExposurePct: 50,
        maxTokenExposurePct: 50,
      }),
      proposedAllocationUsd: 2,
      proposedPoolAddress: "pool_old",
      proposedTokenMints: ["mint_x", "mint_y"],
      recentNewDeploys: 0,
      position: buildOpenPosition({
        currentValueUsd: 4,
        poolAddress: "pool_old",
        tokenXMint: "mint_x",
        tokenYMint: "mint_y",
      }),
    });

    expect(result.allowed).toBe(true);
    expect(result.projectedExposureByPool.pool_old).toBe(20);
    expect(result.projectedExposureByToken.mint_x).toBe(20);
    expect(result.state.capitalUsage.projectedCapitalUsagePct).toBe(60);
  });

  it("releases token exposure safely even when position and proposal use different mint ordering conventions", () => {
    const result = evaluatePortfolioRisk({
      action: "REBALANCE",
      portfolio: buildPortfolio({
        exposureByToken: {
          mint_base: 40,
          mint_quote: 40,
        },
      }),
      policy: buildPolicy({
        maxTokenExposurePct: 50,
      }),
      proposedAllocationUsd: 2,
      proposedPoolAddress: "pool_new",
      proposedTokenMints: ["mint_base", "mint_quote"],
      recentNewDeploys: 0,
      position: buildOpenPosition({
        currentValueUsd: 4,
        tokenXMint: "mint_x",
        tokenYMint: "mint_y",
        baseMint: "mint_base",
        quoteMint: "mint_quote",
      }),
    });

    expect(result.allowed).toBe(true);
    expect(result.projectedExposureByToken.mint_base).toBe(20);
    expect(result.projectedExposureByToken.mint_quote).toBe(20);
  });

  it("treats exact max thresholds as blocked consistently", () => {
    const result = evaluatePortfolioRisk({
      action: "DEPLOY",
      portfolio: buildPortfolio({
        availableBalance: 3,
        exposureByPool: {
          pool_hot: 30,
        },
        exposureByToken: {
          mint_hot: 35,
        },
      }),
      policy: buildPolicy({
        maxCapitalUsagePct: 70,
        maxPoolExposurePct: 40,
        maxTokenExposurePct: 45,
      }),
      proposedAllocationUsd: 1,
      proposedPoolAddress: "pool_hot",
      proposedTokenMints: ["mint_hot"],
      recentNewDeploys: 0,
    });

    expect(result.allowed).toBe(false);
    expect(result.blockingRules).toEqual(
      expect.arrayContaining([
        "projected capital usage reaches or exceeds 70%",
        "projected pool exposure reaches or exceeds maximum",
        "projected token exposure reaches or exceeds maximum for mint_hot",
      ]),
    );
  });

  it("projects pool and token exposure as pure helper functions", () => {
    const portfolio = buildPortfolio({
      exposureByPool: {
        pool_old: 40,
      },
      exposureByToken: {
        mint_x: 40,
        mint_y: 40,
      },
    });

    const byPool = projectExposureByPool({
      portfolio,
      walletBalance: 10,
      poolAddress: "pool_new",
      additionalAllocationUsd: 2,
      releasedPoolAddress: "pool_old",
      releasedAllocationUsd: 4,
    });
    const byToken = projectExposureByToken({
      portfolio,
      walletBalance: 10,
      tokenMints: ["mint_a", "mint_b"],
      additionalAllocationUsd: 2,
      releasedTokenMints: ["mint_x", "mint_y"],
      releasedAllocationUsd: 4,
    });

    expect(byPool.pool_old).toBe(0);
    expect(byPool.pool_new).toBe(20);
    expect(byToken.mint_x).toBe(0);
    expect(byToken.mint_y).toBe(0);
    expect(byToken.mint_a).toBe(20);
    expect(byToken.mint_b).toBe(20);
  });

  it("does not count REBALANCE against maxNewDeploysPerHour", () => {
    const policy = buildPolicy({ maxNewDeploysPerHour: 2 });
    const portfolio = buildPortfolio();
    const position = buildOpenPosition({ currentValueUsd: 2 });

    const rebalanceAtLimit = evaluatePortfolioRisk({
      action: "REBALANCE",
      portfolio,
      policy,
      proposedAllocationUsd: 2,
      proposedPoolAddress: "pool_new",
      proposedTokenMints: ["mint_a", "mint_b"],
      recentNewDeploys: 2,
      position,
    });
    const deployAtLimit = evaluatePortfolioRisk({
      action: "DEPLOY",
      portfolio,
      policy,
      proposedAllocationUsd: 1,
      proposedPoolAddress: "pool_new",
      proposedTokenMints: ["mint_a", "mint_b"],
      recentNewDeploys: 2,
    });

    expect(rebalanceAtLimit.blockingRules).not.toContain(
      "max new deploys per hour reached",
    );
    expect(deployAtLimit.allowed).toBe(false);
    expect(deployAtLimit.blockingRules).toContain(
      "max new deploys per hour reached",
    );
  });

  it("updates daily realized pnl and flips the circuit breaker when the limit is breached", () => {
    const updatedPortfolio = updatePortfolioDailyRiskState({
      portfolio: buildPortfolio(),
      policy: buildPolicy({
        dailyLossLimitPct: 10,
      }),
      realizedPnlDelta: -1.5,
    });

    expect(updatedPortfolio.dailyRealizedPnl).toBe(-1.5);
    expect(updatedPortfolio.drawdownState).toBe("LIMIT_REACHED");
    expect(updatedPortfolio.circuitBreakerState).toBe("ON");
  });

  it("blocks deploy when either percent or absolute SOL daily loss limit is breached", () => {
    const result = evaluatePortfolioRisk({
      action: "DEPLOY",
      portfolio: buildPortfolio({
        dailyRealizedPnl: -25,
      }),
      policy: buildPolicy({
        dailyLossLimitPct: 90,
        maxDailyLossSol: 0.2,
      }),
      solPriceUsd: 100,
      proposedAllocationUsd: 1,
      proposedPoolAddress: "pool_new",
      proposedTokenMints: ["mint_a", "mint_b"],
      recentNewDeploys: 0,
    });

    expect(result.allowed).toBe(false);
    expect(result.blockingRules).toContain(
      "daily realized loss reached 0.2500 SOL",
    );
    expect(result.state.dailyLossSol).toBe(0.25);
  });

  it("blocks deploy conservatively when maxDailyLossSol is configured but SOL price is unavailable", () => {
    const result = evaluatePortfolioRisk({
      action: "DEPLOY",
      portfolio: buildPortfolio({
        dailyRealizedPnl: -5,
      }),
      policy: buildPolicy({
        dailyLossLimitPct: 90,
        maxDailyLossSol: 0.2,
      }),
      proposedAllocationUsd: 1,
      proposedPoolAddress: "pool_new",
      proposedTokenMints: ["mint_a", "mint_b"],
      recentNewDeploys: 0,
    });

    expect(result.allowed).toBe(false);
    expect(result.blockingRules).toContain(
      "daily SOL loss guard cannot be evaluated because solPriceUsd is unavailable",
    );
  });
});
