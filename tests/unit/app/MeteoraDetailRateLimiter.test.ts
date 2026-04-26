import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  FileMeteoraDetailRateLimiter,
  InMemoryMeteoraDetailRateLimiter,
} from "../../../src/app/services/MeteoraDetailRateLimiter.js";

describe("InMemoryMeteoraDetailRateLimiter", () => {
  it("allows the first request", async () => {
    const limiter = new InMemoryMeteoraDetailRateLimiter({
      detailRequestIntervalMs: 4_000,
      maxDetailRequestsPerWindow: 2,
      detailRequestWindowMs: 60_000,
      detailCooldownAfter429Ms: 900_000,
    });

    await expect(
      limiter.beforeRequest("2026-04-26T00:00:00.000Z"),
    ).resolves.toEqual({
      allowed: true,
      waitMs: 0,
    });
  });

  it("returns waitMs when requests are too close together", async () => {
    const limiter = new InMemoryMeteoraDetailRateLimiter({
      detailRequestIntervalMs: 4_000,
      maxDetailRequestsPerWindow: 3,
      detailRequestWindowMs: 60_000,
      detailCooldownAfter429Ms: 900_000,
    });

    await limiter.recordAttempt("2026-04-26T00:00:00.000Z");
    await limiter.recordSuccess("2026-04-26T00:00:00.000Z");

    await expect(
      limiter.beforeRequest("2026-04-26T00:00:01.000Z"),
    ).resolves.toEqual({
      allowed: true,
      waitMs: 3_000,
    });
  });

  it("blocks when the rolling window budget is exhausted", async () => {
    const limiter = new InMemoryMeteoraDetailRateLimiter({
      detailRequestIntervalMs: 0,
      maxDetailRequestsPerWindow: 2,
      detailRequestWindowMs: 60_000,
      detailCooldownAfter429Ms: 900_000,
    });

    await limiter.recordAttempt("2026-04-26T00:00:00.000Z");
    await limiter.recordSuccess("2026-04-26T00:00:00.000Z");
    await limiter.recordAttempt("2026-04-26T00:00:10.000Z");
    await limiter.recordSuccess("2026-04-26T00:00:10.000Z");

    await expect(
      limiter.beforeRequest("2026-04-26T00:00:20.000Z"),
    ).resolves.toEqual({
      allowed: false,
      reason: "window_budget_exhausted",
      retryAfterMs: 40_000,
    });
  });

  it("counts failed attempts against the rolling window budget", async () => {
    const limiter = new InMemoryMeteoraDetailRateLimiter({
      detailRequestIntervalMs: 0,
      maxDetailRequestsPerWindow: 2,
      detailRequestWindowMs: 60_000,
      detailCooldownAfter429Ms: 900_000,
    });

    await limiter.recordAttempt("2026-04-26T00:00:00.000Z");
    await limiter.recordFailure("2026-04-26T00:00:00.000Z");
    await limiter.recordAttempt("2026-04-26T00:00:10.000Z");
    await limiter.recordFailure("2026-04-26T00:00:10.000Z");

    await expect(
      limiter.beforeRequest("2026-04-26T00:00:20.000Z"),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "window_budget_exhausted",
    });
  });

  it("opens and expires cooldown after a 429", async () => {
    const limiter = new InMemoryMeteoraDetailRateLimiter({
      detailRequestIntervalMs: 0,
      maxDetailRequestsPerWindow: 2,
      detailRequestWindowMs: 60_000,
      detailCooldownAfter429Ms: 900_000,
    });

    await limiter.recordAttempt("2026-04-26T00:00:00.000Z");
    await limiter.recordRateLimited({ now: "2026-04-26T00:00:00.000Z" });

    await expect(
      limiter.beforeRequest("2026-04-26T00:10:00.000Z"),
    ).resolves.toEqual({
      allowed: false,
      reason: "endpoint_cooldown_active",
      retryAfterMs: 300_000,
    });
    await expect(
      limiter.beforeRequest("2026-04-26T00:15:00.000Z"),
    ).resolves.toEqual({
      allowed: true,
      waitMs: 0,
    });
  });

  it("persists cooldown and attempts across limiter instances", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "meridian-v2-rate-limit-"),
    );
    const filePath = path.join(directory, "meteora-rate-limit-state.json");
    const options = {
      filePath,
      detailRequestIntervalMs: 0,
      maxDetailRequestsPerWindow: 2,
      detailRequestWindowMs: 60_000,
      detailCooldownAfter429Ms: 900_000,
    };

    try {
      const firstLimiter = new FileMeteoraDetailRateLimiter(options);
      await firstLimiter.recordAttempt("2026-04-26T00:00:00.000Z");
      await firstLimiter.recordRateLimited({
        now: "2026-04-26T00:00:00.000Z",
      });

      const reloadedLimiter = new FileMeteoraDetailRateLimiter(options);

      await expect(
        reloadedLimiter.beforeRequest("2026-04-26T00:10:00.000Z"),
      ).resolves.toEqual({
        allowed: false,
        reason: "endpoint_cooldown_active",
        retryAfterMs: 300_000,
      });
      await expect(reloadedLimiter.snapshot()).resolves.toMatchObject({
        requestCountInWindow: 1,
        cooldownUntil: "2026-04-26T00:15:00.000Z",
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
