import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { StateRepository } from "../../src/adapters/storage/StateRepository.js";
import { runStartupRecoveryChecklist } from "../../src/app/usecases/runStartupRecoveryChecklist.js";
import { type Action } from "../../src/domain/entities/Action.js";
import { FileSchedulerMetadataStore } from "../../src/infra/scheduler/SchedulerMetadataStore.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-startup-"),
  );
  tempDirs.push(directory);
  return directory;
}

function buildAction(): Action {
  return {
    actionId: "act_recovered",
    type: "DEPLOY",
    status: "QUEUED",
    wallet: "wallet_001",
    positionId: null,
    idempotencyKey: "wallet_001:deploy:recovered",
    requestPayload: {
      poolAddress: "pool_a",
    },
    resultPayload: null,
    txIds: [],
    error: null,
    requestedAt: "2026-04-22T10:00:00.000Z",
    startedAt: null,
    completedAt: null,
    requestedBy: "system",
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("startup recovery checklist", () => {
  it("recovers atomic temp artifacts through repository reads and reports healthy state", async () => {
    const directory = await makeTempDir();
    const actionsPath = path.join(directory, "actions.json");
    const journalPath = path.join(directory, "journal.jsonl");
    const positionsPath = path.join(directory, "positions.json");

    await fs.writeFile(
      `${actionsPath}.tmp`,
      JSON.stringify([buildAction()], null, 2),
      "utf8",
    );

    const result = await runStartupRecoveryChecklist({
      wallet: "wallet_001",
      stateRepository: new StateRepository({ filePath: positionsPath }),
      actionRepository: new ActionRepository({ filePath: actionsPath }),
      journalRepository: new JournalRepository({ filePath: journalPath }),
      now: "2026-04-22T10:05:00.000Z",
    });

    expect(result.status).toBe("HEALTHY");
    expect(result.report.actionsByStatus.QUEUED).toBe(1);
    expect(
      result.checklist.find((item) => item.item === "actions_store")?.ok,
    ).toBe(true);
    await expect(fs.readFile(actionsPath, "utf8")).resolves.toContain(
      "act_recovered",
    );
  });

  it("recovers stale RUNNING scheduler state left behind by a previous crash", async () => {
    const directory = await makeTempDir();
    const schedulerMetadataStore = new FileSchedulerMetadataStore({
      filePath: path.join(directory, "scheduler-metadata.json"),
    });

    await schedulerMetadataStore.tryStartRun({
      worker: "management",
      triggerSource: "startup",
      startedAt: "2026-04-22T10:00:00.000Z",
      intervalSec: 300,
    });

    const result = await runStartupRecoveryChecklist({
      wallet: "wallet_001",
      stateRepository: new StateRepository({
        filePath: path.join(directory, "positions.json"),
      }),
      actionRepository: new ActionRepository({
        filePath: path.join(directory, "actions.json"),
      }),
      journalRepository: new JournalRepository({
        filePath: path.join(directory, "journal.jsonl"),
      }),
      schedulerMetadataStore,
      now: "2026-04-22T10:05:00.000Z",
    });

    const recoveredState = await schedulerMetadataStore.get("management");

    expect(result.status).toBe("HEALTHY");
    expect(
      result.checklist.find(
        (item) => item.item === "scheduler_running_recovery",
      ),
    ).toMatchObject({
      ok: true,
      detail: "recovered 1 stale running worker state(s)",
    });
    expect(recoveredState.status).toBe("FAILED");
    expect(recoveredState.lastError).toBe(
      "stale RUNNING state recovered at startup",
    );
    expect(recoveredState.lastCompletedAt).toBe("2026-04-22T10:05:00.000Z");
  });

  it("recovers stale RUNNING actions into confirmation recovery", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    await actionRepository.upsert({
      ...buildAction(),
      status: "RUNNING",
      startedAt: "2026-04-22T10:00:00.000Z",
    });

    const result = await runStartupRecoveryChecklist({
      wallet: "wallet_001",
      stateRepository: new StateRepository({
        filePath: path.join(directory, "positions.json"),
      }),
      actionRepository,
      journalRepository: new JournalRepository({
        filePath: path.join(directory, "journal.jsonl"),
      }),
      now: "2026-04-22T10:05:00.000Z",
    });

    const recoveredAction = await actionRepository.get("act_recovered");

    expect(result.status).toBe("HEALTHY");
    expect(
      result.checklist.find((item) => item.item === "actions_running_recovery"),
    ).toMatchObject({
      ok: true,
      detail: "recovered 1 stale RUNNING action(s)",
    });
    expect(recoveredAction).toMatchObject({
      status: "WAITING_CONFIRMATION",
      error:
        "stale RUNNING action recovered at startup; submission status unknown",
      resultPayload: {
        actionType: "DEPLOY",
        submissionStatus: "maybe_submitted",
        submissionAmbiguous: true,
      },
    });
  });

  it("continues recovering stale RUNNING actions even when recovery journaling fails", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    await actionRepository.upsert({
      ...buildAction(),
      actionId: "act_recovered_1",
      status: "RUNNING",
      startedAt: "2026-04-22T10:00:00.000Z",
    });
    await actionRepository.upsert({
      ...buildAction(),
      actionId: "act_recovered_2",
      idempotencyKey: "wallet_001:deploy:recovered:2",
      status: "RUNNING",
      startedAt: "2026-04-22T10:00:30.000Z",
    });

    const failingJournalRepository = {
      async append() {
        throw new Error("journal unavailable");
      },
      async list() {
        return [];
      },
    } as unknown as JournalRepository;

    const result = await runStartupRecoveryChecklist({
      wallet: "wallet_001",
      stateRepository: new StateRepository({
        filePath: path.join(directory, "positions.json"),
      }),
      actionRepository,
      journalRepository: failingJournalRepository,
      now: "2026-04-22T10:05:00.000Z",
    });

    const recoveredOne = await actionRepository.get("act_recovered_1");
    const recoveredTwo = await actionRepository.get("act_recovered_2");

    expect(result.status).toBe("HEALTHY");
    expect(
      result.checklist.find((item) => item.item === "actions_running_recovery"),
    ).toMatchObject({
      ok: true,
      detail:
        "recovered 2 stale RUNNING action(s) with 2 journal warning(s)",
    });
    expect(recoveredOne?.status).toBe("WAITING_CONFIRMATION");
    expect(recoveredTwo?.status).toBe("WAITING_CONFIRMATION");
  });

  it("returns UNSAFE instead of throwing when an optional store fails report generation checks", async () => {
    const directory = await makeTempDir();

    const result = await runStartupRecoveryChecklist({
      wallet: "wallet_001",
      stateRepository: new StateRepository({
        filePath: path.join(directory, "positions.json"),
      }),
      actionRepository: new ActionRepository({
        filePath: path.join(directory, "actions.json"),
      }),
      journalRepository: new JournalRepository({
        filePath: path.join(directory, "journal.jsonl"),
      }),
      poolMemoryRepository: {
        async get() {
          return null;
        },
        async upsert() {
          throw new Error("unused");
        },
        async listAll() {
          throw new Error("pool memory unavailable");
        },
        async addNote() {
          throw new Error("unused");
        },
        async setCooldown() {
          throw new Error("unused");
        },
      },
      now: "2026-04-22T10:05:00.000Z",
    });

    expect(result.status).toBe("UNSAFE");
    expect(
      result.checklist.find((item) => item.item === "pool_memory_store"),
    ).toMatchObject({
      ok: false,
      detail: "pool memory unavailable",
    });
    expect(result.report.poolsTracked).toBeNull();
  });
});
