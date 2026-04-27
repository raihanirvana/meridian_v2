import { describe, expect, it, vi } from "vitest";

import { runWithSchedulerMetadata } from "../../src/infra/scheduler/runWithSchedulerMetadata.js";
import type { SchedulerMetadataStore } from "../../src/infra/scheduler/SchedulerMetadataStore.js";

function buildSchedulerMetadataStore(overrides: {
  finishRun?: SchedulerMetadataStore["finishRun"];
} = {}): SchedulerMetadataStore {
  return {
    async snapshot() {
      throw new Error("unused");
    },
    async get() {
      throw new Error("unused");
    },
    async recoverStaleRunningWorkers() {
      throw new Error("unused");
    },
    async tryStartRun(input) {
      return {
        started: true,
        state: {
          worker: input.worker,
          status: "RUNNING",
          lastTriggerSource: input.triggerSource,
          lastStartedAt: input.startedAt,
          lastCompletedAt: null,
          lastError: null,
          runCount: 1,
          manualRunCount: 0,
          intervalSec: input.intervalSec ?? null,
          nextDueAt: null,
        },
      };
    },
    finishRun:
      overrides.finishRun ??
      (async () => {
        throw new Error("unused");
      }),
  };
}

describe("runWithSchedulerMetadata", () => {
  it("preserves successful worker results when finishRun(success=true) fails", async () => {
    const finishRun = vi.fn(async (input) => {
      if (input.success) {
        throw new Error("metadata write failed");
      }

      throw new Error("unexpected failure branch");
    });

    const result = await runWithSchedulerMetadata({
      schedulerMetadataStore: buildSchedulerMetadataStore({ finishRun }),
      worker: "management",
      triggerSource: "cron",
      now: () => "2026-04-22T10:00:00.000Z",
      run: async () => "ok",
    });

    expect(result).toEqual({
      status: "COMPLETED",
      result: "ok",
    });
    expect(finishRun).toHaveBeenCalledTimes(1);
    expect(finishRun).toHaveBeenCalledWith({
      worker: "management",
      completedAt: "2026-04-22T10:00:00.000Z",
      success: true,
    });
  });
});
