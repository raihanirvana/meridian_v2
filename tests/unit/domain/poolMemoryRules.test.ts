import { describe, expect, it } from "vitest";

import {
  buildPoolRecallString,
  computePoolAggregates,
  shouldCooldown,
} from "../../../src/domain/rules/poolMemoryRules.js";
import {
  type PoolDeploy,
  type PoolMemoryEntry,
} from "../../../src/domain/entities/PoolMemory.js";

function buildDeploy(overrides: Partial<PoolDeploy> = {}): PoolDeploy {
  return {
    deployedAt: "2026-04-22T00:00:00.000Z",
    closedAt: "2026-04-22T02:00:00.000Z",
    pnlPct: 5,
    pnlUsd: 5,
    initialValueUsd: 100,
    finalValueUsd: 105,
    feesEarnedUsd: 1.25,
    rangeEfficiencyPct: 80,
    minutesHeld: 120,
    closeReason: "take_profit",
    closeReasonDetail: "Trailing take profit exit triggered",
    strategy: "bid_ask",
    volatilityAtDeploy: 12,
    ...overrides,
  };
}

function buildEntry(overrides: Partial<PoolMemoryEntry> = {}): PoolMemoryEntry {
  return {
    poolAddress: "pool_001",
    name: "SOL-USDC",
    baseMint: "mint_sol",
    totalDeploys: 2,
    deploys: [
      buildDeploy(),
      buildDeploy({
        deployedAt: "2026-04-22T03:00:00.000Z",
        closedAt: "2026-04-22T05:00:00.000Z",
        pnlPct: -4,
        pnlUsd: -4,
        finalValueUsd: 96,
        closeReason: "volume_collapse",
        closeReasonDetail: "Volume collapsed after entry",
      }),
    ],
    avgPnlPct: 0.5,
    winRatePct: 50,
    lastDeployedAt: "2026-04-22T05:00:00.000Z",
    lastOutcome: "loss",
    notes: [
      {
        note: "Third deploy usually weak after noon",
        addedAt: "2026-04-22T05:05:00.000Z",
      },
    ],
    snapshots: [
      {
        ts: "2026-04-22T05:00:00.000Z",
        positionId: "pos_001",
        pnlPct: -2,
        pnlUsd: -2,
        inRange: false,
        unclaimedFeesUsd: 1.5,
        minutesOutOfRange: 12,
        ageMinutes: 35,
      },
      {
        ts: "2026-04-22T05:05:00.000Z",
        positionId: "pos_001",
        pnlPct: -4,
        pnlUsd: -4,
        inRange: false,
        unclaimedFeesUsd: 1.8,
        minutesOutOfRange: 18,
        ageMinutes: 40,
      },
    ],
    cooldownUntil: "2026-04-22T09:00:00.000Z",
    ...overrides,
  };
}

describe("pool memory rules", () => {
  it("computes aggregates for zero, three, and five deploys", () => {
    expect(computePoolAggregates([])).toEqual({
      totalDeploys: 0,
      avgPnlPct: 0,
      winRatePct: 0,
      lastOutcome: null,
      lastDeployedAt: null,
    });

    expect(
      computePoolAggregates([
        buildDeploy({ pnlPct: 5 }),
        buildDeploy({ pnlPct: -2 }),
        buildDeploy({
          deployedAt: "2026-04-22T03:00:00.000Z",
          closedAt: "2026-04-22T05:00:00.000Z",
          pnlPct: 1,
        }),
      ]),
    ).toEqual({
      totalDeploys: 3,
      avgPnlPct: 1.33,
      winRatePct: 66.67,
      lastOutcome: "profit",
      lastDeployedAt: "2026-04-22T03:00:00.000Z",
    });

    expect(
      computePoolAggregates([
        buildDeploy({ pnlPct: 5 }),
        buildDeploy({ pnlPct: -2 }),
        buildDeploy({ pnlPct: 1 }),
        buildDeploy({ pnlPct: -8 }),
        buildDeploy({ pnlPct: -3 }),
      ]),
    ).toMatchObject({
      totalDeploys: 5,
      winRatePct: 40,
      lastOutcome: "loss",
    });
  });

  it("builds pool recall string with deploy trend and last note", () => {
    const recall = buildPoolRecallString(buildEntry(), {
      now: "2026-04-22T08:00:00.000Z",
    });

    expect(recall).toContain("POOL MEMORY [SOL-USDC]");
    expect(recall).toContain("avg PnL");
    expect(recall).toContain("Last deploy:");
    expect(recall).toContain(
      "closed by volume_collapse (Volume collapsed after entry)",
    );
    expect(recall).toContain("value $100.00->$96.00");
    expect(recall).toContain("fees $1.25");
    expect(recall).toContain("volatility at deploy");
    expect(recall).toContain("Recent trend:");
    expect(recall).toContain("Cooldown until:");
    expect(recall).toContain("Last note [2026-04-22T05:05:00.000Z]:");
  });

  it("includes up to three recent notes in recall strings", () => {
    const recall = buildPoolRecallString(
      buildEntry({
        notes: [
          {
            note: "old note",
            addedAt: "2026-04-22T01:00:00.000Z",
          },
          {
            note: "avoid after failed rebalance",
            addedAt: "2026-04-22T02:00:00.000Z",
          },
          {
            note: "treat recent profit as unreliable",
            addedAt: "2026-04-22T03:00:00.000Z",
          },
          {
            note: "cooldown until fresh volume returns",
            addedAt: "2026-04-22T04:00:00.000Z",
          },
        ],
      }),
      {
        now: "2026-04-22T08:00:00.000Z",
      },
    );

    expect(recall).toContain("Recent notes:");
    expect(recall).not.toContain("old note");
    expect(recall).toContain("avoid after failed rebalance");
    expect(recall).toContain("treat recent profit as unreliable");
    expect(recall).toContain("cooldown until fresh volume returns");
  });

  it("omits expired cooldowns from recall strings", () => {
    const recall = buildPoolRecallString(
      buildEntry({
        cooldownUntil: "2026-04-22T04:00:00.000Z",
      }),
      {
        now: "2026-04-22T05:00:00.000Z",
      },
    );

    expect(recall).not.toContain("Cooldown until:");
  });

  it("cools down volume collapse by default and can use custom close reason set", () => {
    expect(
      shouldCooldown({
        closeReason: "volume_collapse",
      }),
    ).toBe(true);
    expect(
      shouldCooldown({
        closeReason: "take_profit",
      }),
    ).toBe(false);
    expect(
      shouldCooldown({
        closeReason: "operator",
        closeReasonSet: ["operator"],
      }),
    ).toBe(true);
  });
});
