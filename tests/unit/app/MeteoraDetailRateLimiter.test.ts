import { describe, expect, it } from "vitest";

import { InMemoryMeteoraDetailRateLimiter } from "../../../src/app/services/MeteoraDetailRateLimiter.js";

describe("InMemoryMeteoraDetailRateLimiter", () => {
  it("allows the first request", () => {
    const limiter = new InMemoryMeteoraDetailRateLimiter({
      detailRequestIntervalMs: 4_000,
      maxDetailRequestsPerWindow: 2,
      detailRequestWindowMs: 60_000,
      detailCooldownAfter429Ms: 900_000,
    });

    expect(limiter.beforeRequest("2026-04-26T00:00:00.000Z")).toEqual({
      allowed: true,
      waitMs: 0,
    });
  });

  it("returns waitMs when requests are too close together", () => {
    const limiter = new InMemoryMeteoraDetailRateLimiter({
      detailRequestIntervalMs: 4_000,
      maxDetailRequestsPerWindow: 3,
      detailRequestWindowMs: 60_000,
      detailCooldownAfter429Ms: 900_000,
    });

    limiter.recordSuccess("2026-04-26T00:00:00.000Z");

    expect(limiter.beforeRequest("2026-04-26T00:00:01.000Z")).toEqual({
      allowed: true,
      waitMs: 3_000,
    });
  });

  it("blocks when the rolling window budget is exhausted", () => {
    const limiter = new InMemoryMeteoraDetailRateLimiter({
      detailRequestIntervalMs: 0,
      maxDetailRequestsPerWindow: 2,
      detailRequestWindowMs: 60_000,
      detailCooldownAfter429Ms: 900_000,
    });

    limiter.recordSuccess("2026-04-26T00:00:00.000Z");
    limiter.recordSuccess("2026-04-26T00:00:10.000Z");

    expect(limiter.beforeRequest("2026-04-26T00:00:20.000Z")).toEqual({
      allowed: false,
      reason: "window_budget_exhausted",
      retryAfterMs: 40_000,
    });
  });

  it("opens and expires cooldown after a 429", () => {
    const limiter = new InMemoryMeteoraDetailRateLimiter({
      detailRequestIntervalMs: 0,
      maxDetailRequestsPerWindow: 2,
      detailRequestWindowMs: 60_000,
      detailCooldownAfter429Ms: 900_000,
    });

    limiter.recordRateLimited({ now: "2026-04-26T00:00:00.000Z" });

    expect(limiter.beforeRequest("2026-04-26T00:10:00.000Z")).toEqual({
      allowed: false,
      reason: "endpoint_cooldown_active",
      retryAfterMs: 300_000,
    });
    expect(limiter.beforeRequest("2026-04-26T00:15:00.000Z")).toEqual({
      allowed: true,
      waitMs: 0,
    });
  });
});
