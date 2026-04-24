import type { SchedulerMetadataStore } from "../../infra/scheduler/SchedulerMetadataStore.js";
import { runWithSchedulerMetadata } from "../../infra/scheduler/runWithSchedulerMetadata.js";

import {
  runScreeningCycle,
  type RunScreeningCycleInput,
  type RunScreeningCycleResult,
} from "../usecases/runScreeningCycle.js";

export type ScreeningWorkerInput = RunScreeningCycleInput & {
  schedulerMetadataStore?: SchedulerMetadataStore;
  triggerSource?: "cron" | "manual" | "startup";
  intervalSec?: number;
};

export async function runScreeningWorker(
  input: ScreeningWorkerInput,
): Promise<RunScreeningCycleResult> {
  const scheduled = await runWithSchedulerMetadata({
    ...(input.schedulerMetadataStore === undefined
      ? {}
      : { schedulerMetadataStore: input.schedulerMetadataStore }),
    worker: "screening",
    ...(input.triggerSource === undefined
      ? {}
      : { triggerSource: input.triggerSource }),
    ...(input.intervalSec === undefined
      ? {}
      : { intervalSec: input.intervalSec }),
    ...(input.now === undefined ? {} : { now: input.now }),
    run: async () => runScreeningCycle(input),
  });

  if (scheduled.status === "SKIPPED_ALREADY_RUNNING") {
    const screeningPolicy = await input.policyProvider.resolveScreeningPolicy();
    return {
      wallet: input.wallet,
      evaluatedAt: input.now?.() ?? new Date().toISOString(),
      timeframe: screeningPolicy.timeframe,
      candidates: [],
      shortlist: [],
      aiSource: "DISABLED",
      aiReasoning: null,
    };
  }

  return scheduled.result;
}
