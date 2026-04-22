import {
  reconcilePortfolio,
  type ReconcilePortfolioInput,
  type ReconcilePortfolioResult,
} from "../usecases/reconcilePortfolio.js";
import type { SchedulerMetadataStore } from "../../infra/scheduler/SchedulerMetadataStore.js";
import { runWithSchedulerMetadata } from "../../infra/scheduler/runWithSchedulerMetadata.js";

export type ReconciliationWorkerInput = ReconcilePortfolioInput & {
  schedulerMetadataStore?: SchedulerMetadataStore;
  triggerSource?: "cron" | "manual" | "startup";
  intervalSec?: number;
};

export async function runReconciliationWorker(
  input: ReconciliationWorkerInput,
): Promise<ReconcilePortfolioResult> {
  const scheduled = await runWithSchedulerMetadata({
    ...(input.schedulerMetadataStore === undefined
      ? {}
      : { schedulerMetadataStore: input.schedulerMetadataStore }),
    worker: "reconciliation",
    ...(input.triggerSource === undefined
      ? {}
      : { triggerSource: input.triggerSource }),
    ...(input.intervalSec === undefined
      ? {}
      : { intervalSec: input.intervalSec }),
    run: async () => reconcilePortfolio(input),
  });

  if (scheduled.status === "SKIPPED_ALREADY_RUNNING") {
    return {
      records: [],
    };
  }

  return scheduled.result;
}
