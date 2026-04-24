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
});
