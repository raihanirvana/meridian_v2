import {
  runManagementCycle,
  type RunManagementCycleInput,
  type RunManagementCycleResult,
} from "../usecases/runManagementCycle.js";
import type { SchedulerMetadataStore } from "../../infra/scheduler/SchedulerMetadataStore.js";
import { runWithSchedulerMetadata } from "../../infra/scheduler/runWithSchedulerMetadata.js";

export type ManagementWorkerInput = RunManagementCycleInput & {
  schedulerMetadataStore?: SchedulerMetadataStore;
  triggerSource?: "cron" | "manual" | "startup";
  intervalSec?: number;
};

export async function runManagementWorker(
  input: ManagementWorkerInput,
): Promise<RunManagementCycleResult> {
  const scheduled = await runWithSchedulerMetadata({
    ...(input.schedulerMetadataStore === undefined
      ? {}
      : { schedulerMetadataStore: input.schedulerMetadataStore }),
    worker: "management",
    ...(input.triggerSource === undefined
      ? {}
      : { triggerSource: input.triggerSource }),
    ...(input.intervalSec === undefined
      ? {}
      : { intervalSec: input.intervalSec }),
    ...(input.now === undefined ? {} : { now: input.now }),
    run: async () => runManagementCycle(input),
  });

  if (scheduled.status === "SKIPPED_ALREADY_RUNNING") {
    return {
      wallet: input.wallet,
      evaluatedAt: input.now?.() ?? new Date().toISOString(),
      portfolioState: null,
      positionResults: [],
    };
  }

  return scheduled.result;
}
