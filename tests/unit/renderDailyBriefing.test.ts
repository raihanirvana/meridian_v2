import { describe, expect, it } from "vitest";

import { renderDailyBriefing } from "../../src/app/usecases/renderDailyBriefing.js";
import { type RuntimeReport } from "../../src/app/usecases/generateRuntimeReport.js";

function buildReport(overrides: Partial<RuntimeReport> = {}): RuntimeReport {
  return {
    wallet: "wallet_001",
    generatedAt: "2026-04-22T10:00:00.000Z",
    health: "HEALTHY",
    displayMode: "USD",
    solPriceUsd: 150,
    positionsByStatus: { OPEN: 2 },
    actionsByStatus: { DONE: 3 },
    actionsByType: { CLOSE: 1 },
    openPositions: 2,
    pendingActions: 1,
    pendingReconciliationPositions: 0,
    lessonsCount: 5,
    poolsTracked: 3,
    cooldownPools: 1,
    performanceSummary: null,
    dailyPnlUsd: 42.5,
    dailyPnlSol: 0.2833,
    dailyProfitTargetSol: 0.5,
    dailyProfitTargetReached: false,
    scheduler: null,
    issues: [],
    alerts: [],
    ...overrides,
  };
}

describe("renderDailyBriefing", () => {
  it("renders a stable non-emoji briefing by default", () => {
    const text = renderDailyBriefing({
      report: buildReport(),
    });

    expect(text).toContain("Runtime briefing");
    expect(text).not.toContain("OK ");
    expect(text).toContain("Daily realized pnl: $42.50");
  });

  it("renders optional emoji-style prefixes when enabled", () => {
    const text = renderDailyBriefing({
      report: buildReport({
        displayMode: "SOL",
      }),
      emoji: true,
    });

    expect(text).toContain("✅ Runtime briefing");
    expect(text).toContain("📊 Open positions: 2");
    expect(text).toContain("Daily realized pnl: 0.2833 SOL");
  });
});
