import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileLessonRepository,
  LessonStoreCorruptError,
} from "../../src/adapters/storage/LessonRepository.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-v2-lesson-store-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("lesson repository", () => {
  it("throws LessonStoreCorruptError for invalid JSON", async () => {
    const directory = await makeTempDir();
    const filePath = path.join(directory, "lessons.json");
    await fs.writeFile(filePath, "{ not-json", "utf8");

    const repository = new FileLessonRepository({ filePath });

    await expect(repository.list()).rejects.toBeInstanceOf(LessonStoreCorruptError);
  });

  it("throws LessonStoreCorruptError for invalid store shape", async () => {
    const directory = await makeTempDir();
    const filePath = path.join(directory, "lessons.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        lessons: "broken",
        performance: [],
      }),
      "utf8",
    );

    const repository = new FileLessonRepository({ filePath });

    await expect(repository.list()).rejects.toBeInstanceOf(LessonStoreCorruptError);
  });
});
