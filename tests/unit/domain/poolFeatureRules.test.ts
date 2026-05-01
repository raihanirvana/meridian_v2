import { describe, expect, it } from "vitest";

import {
  buildDataFreshnessSnapshot,
  buildDlmmMicrostructureSnapshot,
  buildMarketFeatureSnapshot,
} from "../../../src/domain/rules/poolFeatureRules.js";

describe("pool feature rules", () => {
  it("computes DLMM active bin age from the provided clock", () => {
    const snapshot = buildDlmmMicrostructureSnapshot({
      binStep: 80,
      activeBin: 1000,
      activeBinObservedAt: "2026-04-22T09:59:00.000Z",
      now: "2026-04-22T10:00:00.000Z",
    });

    expect(snapshot.activeBinAgeMs).toBe(60_000);
  });

  it("rejects invalid DLMM snapshot clocks instead of falling back to wall time", () => {
    expect(() =>
      buildDlmmMicrostructureSnapshot({
        binStep: 80,
        activeBin: 1000,
        activeBinObservedAt: "2026-04-22T09:59:00.000Z",
        now: "not-a-date",
      }),
    ).toThrow("requires a valid ISO timestamp");
  });

  it("does not upscale short-window volume or fee into 24h fields", () => {
    const snapshot = buildMarketFeatureSnapshot({
      volume5mUsd: 1_000,
      fees5mUsd: 10,
      tvlUsd: 100_000,
    });

    expect(snapshot.volume5mUsd).toBe(1_000);
    expect(snapshot.fees5mUsd).toBe(10);
    expect(snapshot.volume24hUsd).toBe(0);
    expect(snapshot.fees24hUsd).toBe(0);
    expect(snapshot.volumeTvlRatio24h).toBe(0);
    expect(snapshot.feeTvlRatio24h).toBe(0);
  });

  it("does not downscale long-window volume or fee into shorter windows", () => {
    const snapshot = buildMarketFeatureSnapshot({
      volume1hUsd: 12_000,
      fees1hUsd: 120,
      tvlUsd: 100_000,
    });

    expect(snapshot.volume1hUsd).toBe(12_000);
    expect(snapshot.fees1hUsd).toBe(120);
    expect(snapshot.volume15mUsd).toBe(0);
    expect(snapshot.volume5mUsd).toBe(0);
    expect(snapshot.fees15mUsd).toBe(0);
    expect(snapshot.fees5mUsd).toBe(0);
  });

  it("excludes optional token intel from required deploy freshness age", () => {
    const snapshot = buildDataFreshnessSnapshot({
      now: "2026-04-22T10:00:00.000Z",
      screeningSnapshotAt: "2026-04-22T09:59:30.000Z",
      poolDetailFetchedAt: "2026-04-22T09:59:45.000Z",
      tokenIntelFetchedAt: null,
      chainSnapshotFetchedAt: "2026-04-22T10:00:00.000Z",
      maxAgeMs: 120_000,
      hasActiveBin: true,
      requireTokenIntel: false,
    });

    expect(snapshot.isFreshEnoughForDeploy).toBe(true);
    expect(snapshot.oldestRequiredSnapshotAgeMs).toBe(30_000);
  });
});
