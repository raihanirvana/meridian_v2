import type {
  SchedulerMetadata,
  SchedulerTriggerSource,
  SchedulerWorkerName,
  SchedulerWorkerState,
} from "../../domain/entities/SchedulerMetadata.js";
import {
  createDefaultSchedulerMetadata,
  SchedulerMetadataSchema,
  SchedulerWorkerStateSchema,
} from "../../domain/entities/SchedulerMetadata.js";
import type { FileStoreOptions } from "../../adapters/storage/FileStore.js";
import { FileStore } from "../../adapters/storage/FileStore.js";

export interface SchedulerMetadataStoreOptions extends FileStoreOptions {
  filePath: string;
}

export interface SchedulerMetadataStore {
  snapshot(): Promise<SchedulerMetadata>;
  get(worker: SchedulerWorkerName): Promise<SchedulerWorkerState>;
  recoverStaleRunningWorkers(recoveredAt: string): Promise<SchedulerWorkerState[]>;
  tryStartRun(input: {
    worker: SchedulerWorkerName;
    triggerSource: SchedulerTriggerSource;
    startedAt: string;
    intervalSec?: number;
  }): Promise<{
    started: boolean;
    state: SchedulerWorkerState;
  }>;
  finishRun(input: {
    worker: SchedulerWorkerName;
    completedAt: string;
    success: boolean;
    error?: string | null;
  }): Promise<SchedulerWorkerState>;
}

export class SchedulerMetadataCorruptError extends Error {
  public constructor(filePath: string, details: string) {
    super(`Scheduler metadata store is corrupt at ${filePath}: ${details}`);
    this.name = "SchedulerMetadataCorruptError";
  }
}

function formatZodError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
}

function parseStore(raw: string | null, filePath: string): SchedulerMetadata {
  if (raw === null) {
    return createDefaultSchedulerMetadata();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SchedulerMetadataCorruptError(
      filePath,
      error instanceof Error ? error.message : "invalid JSON",
    );
  }

  const validated = SchedulerMetadataSchema.safeParse(parsed);
  if (!validated.success) {
    throw new SchedulerMetadataCorruptError(filePath, formatZodError(validated.error));
  }

  return validated.data;
}

function nextDueAt(completedAt: string, intervalSec: number | null): string | null {
  if (intervalSec === null) {
    return null;
  }

  const completedAtMs = Date.parse(completedAt);
  if (Number.isNaN(completedAtMs)) {
    return null;
  }

  return new Date(completedAtMs + intervalSec * 1000).toISOString();
}

export class FileSchedulerMetadataStore implements SchedulerMetadataStore {
  private readonly fileStore: FileStore;
  private readonly filePath: string;

  public constructor(options: SchedulerMetadataStoreOptions) {
    this.fileStore = options.fs === undefined
      ? new FileStore()
      : new FileStore({ fs: options.fs });
    this.filePath = options.filePath;
  }

  public async snapshot(): Promise<SchedulerMetadata> {
    const raw = await this.fileStore.readText(this.filePath);
    return parseStore(raw, this.filePath);
  }

  public async get(worker: SchedulerWorkerName): Promise<SchedulerWorkerState> {
    const store = await this.snapshot();
    return SchedulerWorkerStateSchema.parse(store.workers[worker]);
  }

  public async recoverStaleRunningWorkers(
    recoveredAt: string,
  ): Promise<SchedulerWorkerState[]> {
    let recovered: SchedulerWorkerState[] = [];

    await this.fileStore.updateTextAtomic(this.filePath, async (raw) => {
      const store = parseStore(raw, this.filePath);
      const nextWorkers = { ...store.workers };
      recovered = [];

      for (const worker of Object.keys(nextWorkers) as SchedulerWorkerName[]) {
        const currentState = nextWorkers[worker];
        if (currentState.status !== "RUNNING") {
          continue;
        }

        const recoveredState = SchedulerWorkerStateSchema.parse({
          ...currentState,
          status: "FAILED",
          lastCompletedAt: recoveredAt,
          lastError: "stale RUNNING state recovered at startup",
          nextDueAt: nextDueAt(recoveredAt, currentState.intervalSec),
        });
        nextWorkers[worker] = recoveredState;
        recovered.push(recoveredState);
      }

      return JSON.stringify(
        SchedulerMetadataSchema.parse({
          workers: nextWorkers,
        }),
        null,
        2,
      );
    });

    return recovered;
  }

  public async tryStartRun(input: {
    worker: SchedulerWorkerName;
    triggerSource: SchedulerTriggerSource;
    startedAt: string;
    intervalSec?: number;
  }): Promise<{
    started: boolean;
    state: SchedulerWorkerState;
  }> {
    let result: {
      started: boolean;
      state: SchedulerWorkerState;
    } | null = null;

    await this.fileStore.updateTextAtomic(this.filePath, async (raw) => {
      const store = parseStore(raw, this.filePath);
      const currentState = store.workers[input.worker];

      if (currentState.status === "RUNNING") {
        result = {
          started: false,
          state: currentState,
        };
        return JSON.stringify(store, null, 2);
      }

      const nextState = SchedulerWorkerStateSchema.parse({
        ...currentState,
        status: "RUNNING",
        lastTriggerSource: input.triggerSource,
        lastStartedAt: input.startedAt,
        lastError: null,
        runCount: currentState.runCount + 1,
        manualRunCount:
          currentState.manualRunCount + (input.triggerSource === "manual" ? 1 : 0),
        intervalSec: input.intervalSec ?? currentState.intervalSec,
      });
      const nextStore = SchedulerMetadataSchema.parse({
        workers: {
          ...store.workers,
          [input.worker]: nextState,
        },
      });
      result = {
        started: true,
        state: nextState,
      };
      return JSON.stringify(nextStore, null, 2);
    });

    return result ?? {
      started: false,
      state: await this.get(input.worker),
    };
  }

  public async finishRun(input: {
    worker: SchedulerWorkerName;
    completedAt: string;
    success: boolean;
    error?: string | null;
  }): Promise<SchedulerWorkerState> {
    let result: SchedulerWorkerState | null = null;

    await this.fileStore.updateTextAtomic(this.filePath, async (raw) => {
      const store = parseStore(raw, this.filePath);
      const currentState = store.workers[input.worker];
      const nextState = SchedulerWorkerStateSchema.parse({
        ...currentState,
        status: input.success ? "SUCCEEDED" : "FAILED",
        lastCompletedAt: input.completedAt,
        lastError: input.error ?? null,
        nextDueAt: nextDueAt(input.completedAt, currentState.intervalSec),
      });
      const nextStore = SchedulerMetadataSchema.parse({
        workers: {
          ...store.workers,
          [input.worker]: nextState,
        },
      });
      result = nextState;
      return JSON.stringify(nextStore, null, 2);
    });

    return result ?? this.get(input.worker);
  }
}
