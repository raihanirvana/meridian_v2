import type { SchedulerMetadataStore } from "./SchedulerMetadataStore.js";
import type {
  SchedulerTriggerSource,
  SchedulerWorkerName,
} from "../../domain/entities/SchedulerMetadata.js";
import { logger } from "../logging/logger.js";

export interface RunWithSchedulerMetadataInput<T> {
  schedulerMetadataStore?: SchedulerMetadataStore;
  worker: SchedulerWorkerName;
  triggerSource?: SchedulerTriggerSource;
  intervalSec?: number;
  now?: () => string;
  run: () => Promise<T>;
}

export type RunWithSchedulerMetadataResult<T> =
  | {
      status: "SKIPPED_ALREADY_RUNNING";
      result: null;
    }
  | {
      status: "COMPLETED";
      result: T;
    };

export async function runWithSchedulerMetadata<T>(
  input: RunWithSchedulerMetadataInput<T>,
): Promise<RunWithSchedulerMetadataResult<T>> {
  if (input.schedulerMetadataStore === undefined) {
    return {
      status: "COMPLETED",
      result: await input.run(),
    };
  }

  const startedAt = input.now?.() ?? new Date().toISOString();
  const started = await input.schedulerMetadataStore.tryStartRun({
    worker: input.worker,
    triggerSource: input.triggerSource ?? "cron",
    startedAt,
    ...(input.intervalSec === undefined
      ? {}
      : { intervalSec: input.intervalSec }),
  });

  if (!started.started) {
    return {
      status: "SKIPPED_ALREADY_RUNNING",
      result: null,
    };
  }

  let result: T;
  try {
    result = await input.run();
  } catch (error) {
    try {
      await input.schedulerMetadataStore.finishRun({
        worker: input.worker,
        completedAt: input.now?.() ?? new Date().toISOString(),
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "unknown scheduler worker error",
      });
    } catch (finishError) {
      logger.warn(
        {
          err: finishError,
          worker: input.worker,
        },
        "scheduler finishRun failure metadata write failed after worker error",
      );
    }
    throw error;
  }

  try {
    await input.schedulerMetadataStore.finishRun({
      worker: input.worker,
      completedAt: input.now?.() ?? new Date().toISOString(),
      success: true,
    });
  } catch (error) {
    logger.warn(
      {
        err: error,
        worker: input.worker,
      },
      "scheduler finishRun success metadata write failed; preserving worker success result",
    );
  }

  return {
    status: "COMPLETED",
    result,
  };
}
