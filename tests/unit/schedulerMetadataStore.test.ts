import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileSchedulerMetadataStore } from "../../src/infra/scheduler/SchedulerMetadataStore.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-scheduler-"),
  );
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("scheduler metadata store", () => {
  it("tracks manual runs and prevents double fire while a worker is already running", async () => {
    const directory = await makeTempDir();
    const store = new FileSchedulerMetadataStore({
      filePath: path.join(directory, "scheduler.json"),
    });

    const firstStart = await store.tryStartRun({
      worker: "reporting",
      triggerSource: "manual",
      startedAt: "2026-04-22T10:00:00.000Z",
      intervalSec: 300,
    });
    const secondStart = await store.tryStartRun({
      worker: "reporting",
      triggerSource: "manual",
      startedAt: "2026-04-22T10:00:01.000Z",
    });

    expect(firstStart.started).toBe(true);
    expect(secondStart.started).toBe(false);

    const finished = await store.finishRun({
      worker: "reporting",
      completedAt: "2026-04-22T10:01:00.000Z",
      success: true,
    });

    expect(finished.status).toBe("SUCCEEDED");
    expect(finished.manualRunCount).toBe(1);
    expect(finished.nextDueAt).toBe("2026-04-22T10:06:00.000Z");
  });
});
