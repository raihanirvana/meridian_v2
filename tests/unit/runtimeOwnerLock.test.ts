import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeOwnerLockActiveError,
  acquireRuntimeOwnerLock,
} from "../../src/runtime/RuntimeOwnerLock.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-runtime-lock-"),
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

describe("RuntimeOwnerLock", () => {
  it("blocks a second fresh owner for the same data dir", async () => {
    const directory = await makeTempDir();
    const first = await acquireRuntimeOwnerLock({
      dataDir: directory,
      ownerId: "owner_a",
      now: () => "2026-04-26T00:00:00.000Z",
    });

    await expect(
      acquireRuntimeOwnerLock({
        dataDir: directory,
        ownerId: "owner_b",
        now: () => "2026-04-26T00:00:05.000Z",
      }),
    ).rejects.toBeInstanceOf(RuntimeOwnerLockActiveError);

    await first.release();
  });

  it("takes over a stale owner lock", async () => {
    const directory = await makeTempDir();
    await acquireRuntimeOwnerLock({
      dataDir: directory,
      ownerId: "owner_a",
      now: () => "2026-04-26T00:00:00.000Z",
      staleAfterMs: 30_000,
    });

    const second = await acquireRuntimeOwnerLock({
      dataDir: directory,
      ownerId: "owner_b",
      now: () => "2026-04-26T00:01:00.000Z",
      staleAfterMs: 30_000,
    });

    const lockFile = JSON.parse(
      await fs.readFile(path.join(directory, "meridian.lock"), "utf8"),
    ) as { ownerId: string };
    expect(lockFile.ownerId).toBe("owner_b");

    await second.release();
  });
});
