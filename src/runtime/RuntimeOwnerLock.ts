import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export interface RuntimeOwnerLockRecord {
  ownerId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface RuntimeOwnerLock {
  readonly lockFilePath: string;
  readonly ownerId: string;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
  startHeartbeat(
    intervalMs?: number,
    onLost?: (error: RuntimeOwnerLockLostError) => void,
  ): () => void;
}

export class RuntimeOwnerLockActiveError extends Error {
  public constructor(
    public readonly lockFilePath: string,
    public readonly record: RuntimeOwnerLockRecord,
  ) {
    super(
      `Runtime data directory is already owned by ${record.ownerId} (pid ${record.pid}, heartbeat ${record.heartbeatAt}) at ${lockFilePath}`,
    );
    this.name = "RuntimeOwnerLockActiveError";
  }
}

export class RuntimeOwnerLockLostError extends Error {
  public constructor(
    public readonly lockFilePath: string,
    public readonly ownerId: string,
    public readonly currentOwnerId: string | null,
  ) {
    super(
      `Runtime owner lock at ${lockFilePath} is no longer owned by ${ownerId}` +
        (currentOwnerId === null
          ? " (lock missing or unreadable)"
          : ` (current owner: ${currentOwnerId})`),
    );
    this.name = "RuntimeOwnerLockLostError";
  }
}

function parseLockRecord(raw: string): RuntimeOwnerLockRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeOwnerLockRecord>;
    if (
      typeof parsed.ownerId !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.acquiredAt !== "string" ||
      typeof parsed.heartbeatAt !== "string"
    ) {
      return null;
    }

    return {
      ownerId: parsed.ownerId,
      pid: parsed.pid,
      hostname: parsed.hostname,
      acquiredAt: parsed.acquiredAt,
      heartbeatAt: parsed.heartbeatAt,
    };
  } catch {
    return null;
  }
}

function isFresh(input: {
  record: RuntimeOwnerLockRecord | null;
  nowMs: number;
  staleAfterMs: number;
}): boolean {
  if (input.record === null) {
    return false;
  }

  const heartbeatMs = Date.parse(input.record.heartbeatAt);
  if (Number.isNaN(heartbeatMs)) {
    return false;
  }

  return input.nowMs - heartbeatMs <= input.staleAfterMs;
}

async function writeLockFile(input: {
  lockFilePath: string;
  record: RuntimeOwnerLockRecord;
  exclusive: boolean;
}): Promise<void> {
  const contents = `${JSON.stringify(input.record, null, 2)}\n`;
  await fs.mkdir(path.dirname(input.lockFilePath), { recursive: true });

  if (input.exclusive) {
    const handle = await fs.open(input.lockFilePath, "wx");
    try {
      await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }
    return;
  }

  await fs.writeFile(input.lockFilePath, contents, "utf8");
}

export async function acquireRuntimeOwnerLock(input: {
  dataDir: string;
  now?: () => string;
  staleAfterMs?: number;
  ownerId?: string;
}): Promise<RuntimeOwnerLock> {
  const staleAfterMs = input.staleAfterMs ?? 30_000;
  const lockFilePath = path.join(input.dataDir, "meridian.lock");
  const nowIso = input.now?.() ?? new Date().toISOString();
  const ownerId =
    input.ownerId ?? `${os.hostname()}:${process.pid}:${Date.now()}`;
  const record: RuntimeOwnerLockRecord = {
    ownerId,
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: nowIso,
    heartbeatAt: nowIso,
  };

  try {
    await writeLockFile({ lockFilePath, record, exclusive: true });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }

    const existingRaw = await fs.readFile(lockFilePath, "utf8").catch(() => "");
    const existingRecord = parseLockRecord(existingRaw);
    if (
      isFresh({
        record: existingRecord,
        nowMs: Date.parse(nowIso),
        staleAfterMs,
      })
    ) {
      if (existingRecord === null) {
        throw new Error(
          `Runtime owner lock is active but unreadable at ${lockFilePath}`,
        );
      }
      throw new RuntimeOwnerLockActiveError(lockFilePath, existingRecord);
    }

    await fs.rm(lockFilePath, { force: true });
    await writeLockFile({ lockFilePath, record, exclusive: true });
  }

  const lock: RuntimeOwnerLock = {
    lockFilePath,
    ownerId,
    async heartbeat() {
      const existingRaw = await fs.readFile(lockFilePath, "utf8").catch(
        () => null,
      );
      const existingRecord =
        existingRaw === null ? null : parseLockRecord(existingRaw);
      if (existingRecord?.ownerId !== ownerId) {
        throw new RuntimeOwnerLockLostError(
          lockFilePath,
          ownerId,
          existingRecord?.ownerId ?? null,
        );
      }
      const heartbeatAt = input.now?.() ?? new Date().toISOString();
      await writeLockFile({
        lockFilePath,
        record: {
          ...record,
          heartbeatAt,
        },
        exclusive: false,
      });
    },
    async release() {
      const existingRaw = await fs.readFile(lockFilePath, "utf8").catch(
        () => null,
      );
      const existingRecord =
        existingRaw === null ? null : parseLockRecord(existingRaw);
      if (existingRecord?.ownerId === ownerId) {
        await fs.rm(lockFilePath, { force: true });
      }
    },
    startHeartbeat(intervalMs = 10_000, onLost) {
      let stopped = false;
      const stop = () => {
        if (stopped) {
          return;
        }
        stopped = true;
        clearInterval(timer);
      };
      const timer = setInterval(() => {
        void lock.heartbeat().catch((error) => {
          if (error instanceof RuntimeOwnerLockLostError) {
            stop();
            onLost?.(error);
          }
        });
      }, intervalMs);

      return stop;
    },
  };

  return lock;
}
