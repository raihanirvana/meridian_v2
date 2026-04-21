import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { ActionQueue } from "../../src/app/services/ActionQueue.js";
import {
  createIdempotencyKey,
} from "../../src/app/services/ActionService.js";
import { KeyedLock } from "../../src/infra/locks/KeyedLock.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-v2-queue-"));
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

describe("ActionQueue", () => {
  it("releases keyed locks after work completes", async () => {
    const lock = new KeyedLock();

    expect(lock.isLocked("wallet_001")).toBe(false);

    const running = lock.withLock("wallet_001", async () => {
      expect(lock.isLocked("wallet_001")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "ok";
    });

    await running;

    expect(lock.isLocked("wallet_001")).toBe(false);
  });

  it("ensures two actions for the same wallet never run in parallel", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const actionQueue = new ActionQueue({ actionRepository });

    const requestPayload = { poolAddress: "pool_001" };

    await actionQueue.enqueue({
      type: "DEPLOY",
      wallet: "wallet_001",
      positionId: null,
      idempotencyKey: createIdempotencyKey({
        wallet: "wallet_001",
        type: "DEPLOY",
        positionId: null,
        requestPayload: {
          ...requestPayload,
          candidate: "A",
        },
      }),
      requestPayload: {
        ...requestPayload,
        candidate: "A",
      },
      requestedBy: "system",
      requestedAt: "2026-04-20T00:00:00.000Z",
    });

    await actionQueue.enqueue({
      type: "DEPLOY",
      wallet: "wallet_001",
      positionId: null,
      idempotencyKey: createIdempotencyKey({
        wallet: "wallet_001",
        type: "DEPLOY",
        positionId: null,
        requestPayload: {
          ...requestPayload,
          candidate: "B",
        },
      }),
      requestPayload: {
        ...requestPayload,
        candidate: "B",
      },
      requestedBy: "system",
      requestedAt: "2026-04-20T00:00:01.000Z",
    });

    let activeHandlers = 0;
    let maxConcurrentHandlers = 0;

    const handler = async () => {
      activeHandlers += 1;
      maxConcurrentHandlers = Math.max(maxConcurrentHandlers, activeHandlers);
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeHandlers -= 1;

      return {
        nextStatus: "WAITING_CONFIRMATION" as const,
      };
    };

    const [firstResult, secondResult] = await Promise.all([
      actionQueue.processNext(handler),
      actionQueue.processNext(handler),
    ]);

    expect(firstResult?.status).toBe("WAITING_CONFIRMATION");
    expect(secondResult?.status).toBe("WAITING_CONFIRMATION");
    expect(maxConcurrentHandlers).toBe(1);
  });

  it("does not duplicate actions when idempotency key is reused", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const actionQueue = new ActionQueue({ actionRepository });

    const idempotencyKey = createIdempotencyKey({
      wallet: "wallet_001",
      type: "DEPLOY",
      positionId: null,
      requestPayload: {
        poolAddress: "pool_001",
      },
    });

    const firstAction = await actionQueue.enqueue({
      type: "DEPLOY",
      wallet: "wallet_001",
      positionId: null,
      idempotencyKey,
      requestPayload: {
        poolAddress: "pool_001",
      },
      requestedBy: "system",
    });

    const secondAction = await actionQueue.enqueue({
      type: "DEPLOY",
      wallet: "wallet_001",
      positionId: null,
      idempotencyKey,
      requestPayload: {
        poolAddress: "pool_001",
      },
      requestedBy: "system",
    });

    const actions = await actionRepository.list();

    expect(actions).toHaveLength(1);
    expect(secondAction.actionId).toBe(firstAction.actionId);
  });

  it("can pause and resume queue processing", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const actionQueue = new ActionQueue({ actionRepository });

    await actionQueue.enqueue({
      type: "DEPLOY",
      wallet: "wallet_001",
      positionId: null,
      idempotencyKey: createIdempotencyKey({
        wallet: "wallet_001",
        type: "DEPLOY",
        positionId: null,
        requestPayload: {
          poolAddress: "pool_001",
        },
      }),
      requestPayload: {
        poolAddress: "pool_001",
      },
      requestedBy: "system",
    });

    actionQueue.pause();
    expect(actionQueue.isPaused()).toBe(true);

    const pausedResult = await actionQueue.processNext(async () => ({
      nextStatus: "WAITING_CONFIRMATION",
    }));
    expect(pausedResult).toBeNull();

    const queuedBeforeResume = await actionRepository.list();
    expect(queuedBeforeResume[0]?.status).toBe("QUEUED");

    actionQueue.resume();
    expect(actionQueue.isPaused()).toBe(false);

    const resumedResult = await actionQueue.processNext(async () => ({
      nextStatus: "WAITING_CONFIRMATION",
    }));
    expect(resumedResult?.status).toBe("WAITING_CONFIRMATION");
  });

  it("marks actions as FAILED when the handler throws", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const actionQueue = new ActionQueue({ actionRepository });

    const enqueued = await actionQueue.enqueue({
      type: "DEPLOY",
      wallet: "wallet_001",
      positionId: null,
      idempotencyKey: createIdempotencyKey({
        wallet: "wallet_001",
        type: "DEPLOY",
        positionId: null,
        requestPayload: {
          poolAddress: "pool_001",
        },
      }),
      requestPayload: {
        poolAddress: "pool_001",
      },
      requestedBy: "system",
    });

    const processed = await actionQueue.processNext(async () => {
      throw new Error("handler exploded");
    });

    const persisted = await actionRepository.get(enqueued.actionId);

    expect(processed?.status).toBe("FAILED");
    expect(processed?.error).toMatch(/handler exploded/i);
    expect(persisted?.status).toBe("FAILED");
    expect(persisted?.error).toMatch(/handler exploded/i);
  });

  it("falls back to a safe error message when the handler throws an empty Error", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const actionQueue = new ActionQueue({ actionRepository });

    const enqueued = await actionQueue.enqueue({
      type: "DEPLOY",
      wallet: "wallet_001",
      positionId: null,
      idempotencyKey: createIdempotencyKey({
        wallet: "wallet_001",
        type: "DEPLOY",
        positionId: null,
        requestPayload: {
          poolAddress: "pool_001",
        },
      }),
      requestPayload: {
        poolAddress: "pool_001",
      },
      requestedBy: "system",
    });

    const processed = await actionQueue.processNext(async () => {
      throw new Error("");
    });

    const persisted = await actionRepository.get(enqueued.actionId);

    expect(processed?.status).toBe("FAILED");
    expect(processed?.error).toBe("unknown handler error");
    expect(persisted?.error).toBe("unknown handler error");
  });

  it("writes journal events for enqueue, running, and finalize when a journal repository is provided", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const journalRepository = new JournalRepository({
      filePath: path.join(directory, "journal.jsonl"),
    });
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository,
    });

    await actionQueue.enqueue({
      type: "DEPLOY",
      wallet: "wallet_001",
      positionId: null,
      idempotencyKey: createIdempotencyKey({
        wallet: "wallet_001",
        type: "DEPLOY",
        positionId: null,
        requestPayload: {
          poolAddress: "pool_001",
        },
      }),
      requestPayload: {
        poolAddress: "pool_001",
      },
      requestedBy: "system",
    });

    await actionQueue.processNext(async () => ({
      nextStatus: "WAITING_CONFIRMATION",
      txIds: ["tx_001"],
    }));

    const events = await journalRepository.list();

    expect(events.map((event) => event.eventType)).toEqual([
      "ACTION_ENQUEUED",
      "ACTION_RUNNING",
      "ACTION_FINALIZED",
    ]);
  });

  it("clears claimed action ids when processing fails before the handler runs", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });

    let shouldThrow = true;
    const throwingWalletLock = {
      isLocked: () => false,
      withLock: async <T>(_wallet: string, work: () => Promise<T>): Promise<T> => {
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error("wallet lock unavailable");
        }

        return work();
      },
    };

    const actionQueue = new ActionQueue({
      actionRepository,
      walletLock: throwingWalletLock as never,
    });

    await actionQueue.enqueue({
      type: "DEPLOY",
      wallet: "wallet_001",
      positionId: null,
      idempotencyKey: createIdempotencyKey({
        wallet: "wallet_001",
        type: "DEPLOY",
        positionId: null,
        requestPayload: {
          poolAddress: "pool_001",
        },
      }),
      requestPayload: {
        poolAddress: "pool_001",
      },
      requestedBy: "system",
    });

    await expect(
      actionQueue.processNext(async () => ({
        nextStatus: "WAITING_CONFIRMATION",
      })),
    ).rejects.toThrow(/wallet lock unavailable/i);

    const processedAfterRetry = await actionQueue.processNext(async () => ({
      nextStatus: "WAITING_CONFIRMATION",
    }));

    expect(processedAfterRetry?.status).toBe("WAITING_CONFIRMATION");
  });

  it("resets startedAt for a retried action when it enters RUNNING again", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const actionQueue = new ActionQueue({ actionRepository });

    const action = await actionQueue.enqueue({
      type: "DEPLOY",
      wallet: "wallet_001",
      positionId: null,
      idempotencyKey: createIdempotencyKey({
        wallet: "wallet_001",
        type: "DEPLOY",
        positionId: null,
        requestPayload: {
          poolAddress: "pool_001",
        },
      }),
      requestPayload: {
        poolAddress: "pool_001",
      },
      requestedBy: "system",
      requestedAt: "2026-04-20T00:00:00.000Z",
    });

    await actionRepository.upsert({
      ...action,
      status: "RETRY_QUEUED",
      startedAt: "2026-04-20T00:01:00.000Z",
      completedAt: null,
      error: "previous failure",
    });

    const retried = await actionQueue.processNext(async () => ({
      nextStatus: "WAITING_CONFIRMATION",
    }));

    expect(retried?.status).toBe("WAITING_CONFIRMATION");
    expect(retried?.startedAt).not.toBe("2026-04-20T00:01:00.000Z");
  });
});
