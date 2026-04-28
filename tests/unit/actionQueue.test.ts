import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ActionRepository } from "../../src/adapters/storage/ActionRepository.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import { ActionQueue } from "../../src/app/services/ActionQueue.js";
import { createIdempotencyKey } from "../../src/app/services/ActionService.js";
import { KeyedLock } from "../../src/infra/locks/KeyedLock.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-queue-"),
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

    expect([firstResult?.status ?? null, secondResult?.status ?? null]).toEqual(
      expect.arrayContaining(["WAITING_CONFIRMATION", null]),
    );
    expect(maxConcurrentHandlers).toBe(1);

    const actions = await actionRepository.list();
    expect(actions.filter((action) => action.status === "QUEUED")).toHaveLength(
      1,
    );
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

  it("does not duplicate actions when the same idempotency key is enqueued concurrently", async () => {
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

    const [firstAction, secondAction] = await Promise.all([
      actionQueue.enqueue({
        type: "DEPLOY",
        wallet: "wallet_001",
        positionId: null,
        idempotencyKey,
        requestPayload: {
          poolAddress: "pool_001",
        },
        requestedBy: "system",
      }),
      actionQueue.enqueue({
        type: "DEPLOY",
        wallet: "wallet_001",
        positionId: null,
        idempotencyKey,
        requestPayload: {
          poolAddress: "pool_001",
        },
        requestedBy: "system",
      }),
    ]);

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

  it("preserves WAITING_CONFIRMATION when final journal append fails after state persistence", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    let appendCount = 0;
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository: {
        append: async (event) => {
          appendCount += 1;
          if (event.eventType === "ACTION_FINALIZED") {
            throw new Error("journal unavailable");
          }
        },
      } as JournalRepository,
    });

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
    });

    const processed = await actionQueue.processNext(async () => ({
      nextStatus: "WAITING_CONFIRMATION",
      txIds: ["tx_001"],
    }));

    const persisted = await actionRepository.get(action.actionId);

    expect(appendCount).toBeGreaterThanOrEqual(2);
    expect(processed?.status).toBe("WAITING_CONFIRMATION");
    expect(processed?.txIds).toEqual(["tx_001"]);
    expect(persisted?.status).toBe("WAITING_CONFIRMATION");
    expect(persisted?.txIds).toEqual(["tx_001"]);
  });

  it("still runs the handler when ACTION_RUNNING journal append fails", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    let handlerCalls = 0;
    const actionQueue = new ActionQueue({
      actionRepository,
      journalRepository: {
        append: async (event) => {
          if (event.eventType === "ACTION_RUNNING") {
            throw new Error("journal unavailable");
          }
        },
      } as JournalRepository,
    });

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
    });

    const processed = await actionQueue.processNext(async () => {
      handlerCalls += 1;
      return {
        nextStatus: "WAITING_CONFIRMATION",
      };
    });

    const persisted = await actionRepository.get(action.actionId);

    expect(handlerCalls).toBe(1);
    expect(processed?.status).toBe("WAITING_CONFIRMATION");
    expect(persisted?.status).toBe("WAITING_CONFIRMATION");
  });

  it("allows only one queue instance to claim the same queued action", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });
    const firstQueue = new ActionQueue({ actionRepository });
    const secondQueue = new ActionQueue({ actionRepository });

    await firstQueue.enqueue({
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

    let handlerCalls = 0;
    const handler = async () => {
      handlerCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        nextStatus: "WAITING_CONFIRMATION" as const,
      };
    };

    const [firstResult, secondResult] = await Promise.all([
      firstQueue.processNext(handler),
      secondQueue.processNext(handler),
    ]);

    expect(handlerCalls).toBe(1);
    expect([firstResult?.status ?? null, secondResult?.status ?? null]).toContain(
      "WAITING_CONFIRMATION",
    );
    expect([firstResult, secondResult]).toContain(null);
  });

  it("does not claim another queued action for a wallet with an active write", async () => {
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
          poolAddress: "pool_a",
        },
      }),
      requestPayload: {
        poolAddress: "pool_a",
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
          poolAddress: "pool_b",
        },
      }),
      requestPayload: {
        poolAddress: "pool_b",
      },
      requestedBy: "system",
      requestedAt: "2026-04-20T00:00:01.000Z",
    });
    await actionQueue.enqueue({
      type: "DEPLOY",
      wallet: "wallet_002",
      positionId: null,
      idempotencyKey: createIdempotencyKey({
        wallet: "wallet_002",
        type: "DEPLOY",
        positionId: null,
        requestPayload: {
          poolAddress: "pool_c",
        },
      }),
      requestPayload: {
        poolAddress: "pool_c",
      },
      requestedBy: "system",
      requestedAt: "2026-04-20T00:00:02.000Z",
    });

    const processedWallets: string[] = [];
    const handler = async (action: { wallet: string }) => {
      processedWallets.push(action.wallet);
      return {
        nextStatus: "WAITING_CONFIRMATION" as const,
      };
    };

    const first = await actionQueue.processNext(handler);
    const second = await actionQueue.processNext(handler);
    const third = await actionQueue.processNext(handler);
    const actions = await actionRepository.list();
    const walletOneQueued = actions.find(
      (action) =>
        action.wallet === "wallet_001" &&
        action.requestPayload.poolAddress === "pool_b",
    );

    expect(first?.wallet).toBe("wallet_001");
    expect(second?.wallet).toBe("wallet_002");
    expect(third).toBeNull();
    expect(processedWallets).toEqual(["wallet_001", "wallet_002"]);
    expect(walletOneQueued?.status).toBe("QUEUED");
  });

  it("clears claimed action ids when processing fails before the handler runs", async () => {
    const directory = await makeTempDir();
    const actionRepository = new ActionRepository({
      filePath: path.join(directory, "actions.json"),
    });

    let shouldThrow = true;
    const throwingWalletLock = {
      isLocked: () => false,
      withLock: async <T>(
        _wallet: string,
        work: () => Promise<T>,
      ): Promise<T> => {
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
