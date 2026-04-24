import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSignalWeightsStore,
  SignalWeightsStoreCorruptError,
} from "../../../src/adapters/storage/SignalWeightsStore.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-signal-weights-"),
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

describe("signal weights store", () => {
  it("returns default weights when file does not exist", async () => {
    const directory = await makeTempDir();
    const store = new FileSignalWeightsStore({
      filePath: path.join(directory, "signal-weights.json"),
    });

    const weights = await store.load();

    expect(weights.feeToTvl.weight).toBe(1);
    expect(weights.organicScore.sampleSize).toBe(0);
  });

  it("throws SignalWeightsStoreCorruptError for invalid file content", async () => {
    const directory = await makeTempDir();
    const filePath = path.join(directory, "signal-weights.json");
    await fs.writeFile(filePath, '{"broken":true}', "utf8");

    const store = new FileSignalWeightsStore({ filePath });

    await expect(store.load()).rejects.toBeInstanceOf(
      SignalWeightsStoreCorruptError,
    );
  });
});
