import { describe, expect, it } from "vitest";

import { buildDlmmMicrostructureSnapshot } from "../../../src/domain/rules/poolFeatureRules.js";

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
});
