import { describe, expect, it } from "vitest";

import { resolveAdaptiveScreeningIntervalSec } from "../../src/app/services/AdaptiveScreeningInterval.js";

describe("adaptive screening interval", () => {
  it("uses tighter interval inside configured peak hours in the configured timezone", () => {
    const interval = resolveAdaptiveScreeningIntervalSec({
      defaultIntervalSec: 1800,
      timezone: "Asia/Jakarta",
      peakHours: [
        {
          start: "09:00",
          end: "14:00",
          intervalSec: 600,
        },
      ],
      now: new Date("2026-04-22T03:30:00.000Z"),
    });

    expect(interval).toBe(600);
  });

  it("falls back to default interval outside configured windows", () => {
    const interval = resolveAdaptiveScreeningIntervalSec({
      defaultIntervalSec: 1800,
      timezone: "Asia/Jakarta",
      peakHours: [
        {
          start: "09:00",
          end: "14:00",
          intervalSec: 600,
        },
      ],
      now: new Date("2026-04-22T23:30:00.000Z"),
    });

    expect(interval).toBe(1800);
  });
});
