import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ActionRepository,
  ActionStoreCorruptError,
} from "../../src/adapters/storage/ActionRepository.js";
import {
  type FileSystemAdapter,
  FileStore,
} from "../../src/adapters/storage/FileStore.js";
import { JournalRepository } from "../../src/adapters/storage/JournalRepository.js";
import type { JournalStoreCorruptError } from "../../src/adapters/storage/JournalRepository.js";
import {
  StateRepository,
  StateStoreCorruptError,
} from "../../src/adapters/storage/StateRepository.js";
import { type Action } from "../../src/domain/entities/Action.js";
import { type JournalEvent } from "../../src/domain/entities/JournalEvent.js";
import { type Position } from "../../src/domain/entities/Position.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "meridian-v2-storage-"),
  );
  tempDirs.push(directory);
  return directory;
}

function buildPosition(positionId: string): Position {
  return {
    positionId,
    poolAddress: "pool_001",
    tokenXMint: "mint_x",
    tokenYMint: "mint_y",
    baseMint: "mint_base",
    quoteMint: "mint_quote",
    wallet: "wallet_001",
    status: "OPEN",
    openedAt: "2026-04-20T00:00:00.000Z",
    lastSyncedAt: "2026-04-20T00:00:00.000Z",
    closedAt: null,
    deployAmountBase: 1,
    deployAmountQuote: 0.5,
    currentValueBase: 1,
    currentValueUsd: 100,
    feesClaimedBase: 0,
    feesClaimedUsd: 0,
    realizedPnlBase: 0,
    realizedPnlUsd: 0,
    unrealizedPnlBase: 0,
    unrealizedPnlUsd: 0,
    rebalanceCount: 0,
    partialCloseCount: 0,
    strategy: "bid_ask",
    rangeLowerBin: 10,
    rangeUpperBin: 20,
    activeBin: 25,
    outOfRangeSince: "2026-04-20T01:00:00.000Z",
    lastManagementDecision: null,
    lastManagementReason: null,
    lastWriteActionId: null,
    needsReconciliation: false,
  };
}

function buildAction(actionId: string): Action {
  return {
    actionId,
    type: "DEPLOY",
    status: "QUEUED",
    wallet: "wallet_001",
    positionId: null,
    idempotencyKey: `wallet_001:${actionId}`,
    requestPayload: {
      poolAddress: "pool_001",
    },
    resultPayload: null,
    txIds: [],
    error: null,
    requestedAt: "2026-04-20T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    requestedBy: "system",
  };
}

function buildJournalEvent(eventType: string, actionId: string): JournalEvent {
  return {
    timestamp: "2026-04-20T00:00:00.000Z",
    eventType,
    actor: "system",
    wallet: "wallet_001",
    positionId: null,
    actionId,
    before: null,
    after: {
      status: "QUEUED",
    },
    txIds: [],
    resultStatus: "OK",
    error: null,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("storage repositories", () => {
  it("persists and reloads positions and actions across repository instances", async () => {
    const directory = await makeTempDir();
    const positionsPath = path.join(directory, "positions.json");
    const actionsPath = path.join(directory, "actions.json");

    const stateRepository = new StateRepository({ filePath: positionsPath });
    const actionRepository = new ActionRepository({ filePath: actionsPath });

    await stateRepository.upsert(buildPosition("pos_001"));
    await actionRepository.upsert(buildAction("act_001"));

    const reloadedStateRepository = new StateRepository({
      filePath: positionsPath,
    });
    const reloadedActionRepository = new ActionRepository({
      filePath: actionsPath,
    });

    const positions = await reloadedStateRepository.list();
    const actions = await reloadedActionRepository.list();

    expect(positions).toHaveLength(1);
    expect(positions[0]?.positionId).toBe("pos_001");
    expect(actions).toHaveLength(1);
    expect(actions[0]?.actionId).toBe("act_001");
  });

  it("appends journal events in order and reloads them from disk", async () => {
    const directory = await makeTempDir();
    const journalPath = path.join(directory, "journal.jsonl");
    const journalRepository = new JournalRepository({ filePath: journalPath });

    await journalRepository.append(
      buildJournalEvent("ACTION_QUEUED", "act_001"),
    );
    await journalRepository.append(
      buildJournalEvent("ACTION_STARTED", "act_001"),
    );

    const reloadedJournalRepository = new JournalRepository({
      filePath: journalPath,
    });
    const events = await reloadedJournalRepository.list();

    expect(events.map((event) => event.eventType)).toEqual([
      "ACTION_QUEUED",
      "ACTION_STARTED",
    ]);
  });

  it("keeps the original file intact when an atomic replace fails midway", async () => {
    const directory = await makeTempDir();
    const positionsPath = path.join(directory, "positions.json");
    const originalContents = JSON.stringify(
      [buildPosition("pos_original")],
      null,
      2,
    );
    await fs.writeFile(positionsPath, originalContents, "utf8");

    let renameCount = 0;
    const flakyFs: FileSystemAdapter = {
      access: (filePath) => fs.access(filePath),
      appendFile: (filePath, data, encoding) =>
        fs.appendFile(filePath, data, encoding),
      mkdir: (dirPath, options) => fs.mkdir(dirPath, options),
      readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
      rename: async (fromPath, toPath) => {
        renameCount += 1;
        if (renameCount === 2) {
          throw new Error("simulated rename failure");
        }

        await fs.rename(fromPath, toPath);
      },
      rm: (targetPath, options) => fs.rm(targetPath, options),
      writeFile: (filePath, data, encoding) =>
        fs.writeFile(filePath, data, encoding),
    };

    const stateRepository = new StateRepository({
      filePath: positionsPath,
      fs: flakyFs,
    });

    await expect(
      stateRepository.replaceAll([buildPosition("pos_new")]),
    ).rejects.toThrow(/simulated rename failure/i);

    const persistedContents = await fs.readFile(positionsPath, "utf8");
    const parsed = JSON.parse(persistedContents) as Array<{
      positionId: string;
    }>;

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.positionId).toBe("pos_original");
  });

  it("writes text atomically for new files", async () => {
    const directory = await makeTempDir();
    const filePath = path.join(directory, "custom.json");
    const fileStore = new FileStore();

    await fileStore.writeTextAtomic(
      filePath,
      JSON.stringify({ ok: true }, null, 2),
    );

    await expect(fs.readFile(filePath, "utf8")).resolves.toContain(
      '"ok": true',
    );
  });

  it("does not lose updates when two repository upserts happen concurrently", async () => {
    const directory = await makeTempDir();
    const positionsPath = path.join(directory, "positions.json");
    const stateRepository = new StateRepository({ filePath: positionsPath });

    await Promise.all([
      stateRepository.upsert(buildPosition("pos_a")),
      stateRepository.upsert(buildPosition("pos_b")),
    ]);

    const positions = await stateRepository.list();
    expect(positions.map((position) => position.positionId).sort()).toEqual([
      "pos_a",
      "pos_b",
    ]);
  });

  it("recovers from orphan temp or backup files when the target file is missing", async () => {
    const directory = await makeTempDir();
    const filePath = path.join(directory, "positions.json");
    const backupPath = `${filePath}.bak`;
    const tempPath = `${filePath}.tmp`;
    const fileStore = new FileStore();

    await fs.writeFile(
      tempPath,
      JSON.stringify([{ positionId: "from_temp" }]),
      "utf8",
    );
    await fs.writeFile(
      backupPath,
      JSON.stringify([{ positionId: "from_backup" }]),
      "utf8",
    );

    const recoveredFromTemp = await fileStore.readText(filePath);
    expect(recoveredFromTemp).toContain("from_temp");

    await fs.rm(filePath, { force: true });
    await fs.writeFile(
      backupPath,
      JSON.stringify([{ positionId: "from_backup" }]),
      "utf8",
    );

    const recoveredFromBackup = await fileStore.readText(filePath);
    expect(recoveredFromBackup).toContain("from_backup");
  });

  it("tolerates a malformed trailing journal line", async () => {
    const directory = await makeTempDir();
    const journalPath = path.join(directory, "journal.jsonl");
    await fs.writeFile(
      journalPath,
      `${JSON.stringify(buildJournalEvent("ACTION_QUEUED", "act_001"))}\n{bad json}\n`,
      "utf8",
    );

    const journalRepository = new JournalRepository({ filePath: journalPath });
    const events = await journalRepository.list();

    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("ACTION_QUEUED");
  });

  it("emits a structured recovery event when skipping a malformed trailing journal line", async () => {
    const directory = await makeTempDir();
    const journalPath = path.join(directory, "journal.jsonl");
    await fs.writeFile(
      journalPath,
      `${JSON.stringify(buildJournalEvent("ACTION_QUEUED", "act_001"))}\n{bad json}\n`,
      "utf8",
    );

    const recoveryEvents: Array<{
      type: string;
      lineNumber: number;
      filePath: string;
      reason: string;
    }> = [];
    const journalRepository = new JournalRepository({
      filePath: journalPath,
      onRecovery: (event) => {
        recoveryEvents.push({
          type: event.type,
          lineNumber: event.lineNumber,
          filePath: event.filePath,
          reason: event.reason,
        });
      },
    });
    const events = await journalRepository.list();

    expect(events).toHaveLength(1);
    expect(recoveryEvents).toHaveLength(1);
    expect(recoveryEvents[0]?.type).toBe("JOURNAL_TRAILING_LINE_SKIPPED");
    expect(recoveryEvents[0]?.lineNumber).toBe(2);
    expect(recoveryEvents[0]?.filePath).toBe(journalPath);
    expect(recoveryEvents[0]?.reason.length).toBeGreaterThan(0);
  });

  it("repairs a malformed trailing journal line before appending a new event", async () => {
    const directory = await makeTempDir();
    const journalPath = path.join(directory, "journal.jsonl");
    await fs.writeFile(
      journalPath,
      `${JSON.stringify(buildJournalEvent("ACTION_QUEUED", "act_001"))}\n{bad json}\n`,
      "utf8",
    );

    const journalRepository = new JournalRepository({ filePath: journalPath });
    await journalRepository.append(
      buildJournalEvent("ACTION_RUNNING", "act_001"),
    );

    const events = await journalRepository.list();
    const raw = await fs.readFile(journalPath, "utf8");

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.eventType)).toEqual([
      "ACTION_QUEUED",
      "ACTION_RUNNING",
    ]);
    expect(raw).not.toContain("{bad json");
  });

  it("does not let append turn trailing corruption into middle corruption", async () => {
    const directory = await makeTempDir();
    const journalPath = path.join(directory, "journal.jsonl");
    await fs.writeFile(
      journalPath,
      `${JSON.stringify(buildJournalEvent("ACTION_QUEUED", "act_001"))}\n{bad json}\n`,
      "utf8",
    );

    const journalRepository = new JournalRepository({ filePath: journalPath });
    await journalRepository.append(
      buildJournalEvent("ACTION_STARTED", "act_001"),
    );

    const reloadedJournalRepository = new JournalRepository({
      filePath: journalPath,
    });

    await expect(reloadedJournalRepository.list()).resolves.toMatchObject([
      { eventType: "ACTION_QUEUED" },
      { eventType: "ACTION_STARTED" },
    ]);
  });

  it("cleans orphan unique temp files even when the target file does not exist", async () => {
    const directory = await makeTempDir();
    const filePath = path.join(directory, "positions.json");
    const orphanPath = `${filePath}.tmp.orphaned`;
    const fileStore = new FileStore();

    await fs.writeFile(orphanPath, JSON.stringify([{ orphan: true }]), "utf8");

    const contents = await fileStore.readText(filePath);

    expect(contents).toBeNull();
    await expect(fs.access(orphanPath)).rejects.toThrow();
  });

  it("throws StateStoreCorruptError when positions.json contains invalid JSON", async () => {
    const directory = await makeTempDir();
    const positionsPath = path.join(directory, "positions.json");
    await fs.writeFile(positionsPath, "{not valid json", "utf8");

    const stateRepository = new StateRepository({ filePath: positionsPath });

    await expect(stateRepository.list()).rejects.toBeInstanceOf(
      StateStoreCorruptError,
    );
  });

  it("throws StateStoreCorruptError when positions.json fails schema validation", async () => {
    const directory = await makeTempDir();
    const positionsPath = path.join(directory, "positions.json");
    await fs.writeFile(
      positionsPath,
      JSON.stringify([{ wrong: true }]),
      "utf8",
    );

    const stateRepository = new StateRepository({ filePath: positionsPath });

    await expect(stateRepository.list()).rejects.toBeInstanceOf(
      StateStoreCorruptError,
    );
  });

  it("throws ActionStoreCorruptError when actions.json contains invalid JSON", async () => {
    const directory = await makeTempDir();
    const actionsPath = path.join(directory, "actions.json");
    await fs.writeFile(actionsPath, "not json at all", "utf8");

    const actionRepository = new ActionRepository({ filePath: actionsPath });

    await expect(actionRepository.list()).rejects.toBeInstanceOf(
      ActionStoreCorruptError,
    );
  });

  it("cleans up orphan unique temp files during recovery", async () => {
    const directory = await makeTempDir();
    const filePath = path.join(directory, "positions.json");
    const fileStore = new FileStore();

    await fs.writeFile(filePath, JSON.stringify([]), "utf8");
    const orphanA = `${filePath}.tmp.orphan-a-uuid`;
    const orphanB = `${filePath}.tmp.orphan-b-uuid`;
    await fs.writeFile(orphanA, "stale", "utf8");
    await fs.writeFile(orphanB, "stale", "utf8");

    await fileStore.readText(filePath);

    await expect(fs.access(orphanA)).rejects.toThrow();
    await expect(fs.access(orphanB)).rejects.toThrow();
  });

  it("throws a corruption error for malformed journal lines in the middle of the file", async () => {
    const directory = await makeTempDir();
    const journalPath = path.join(directory, "journal.jsonl");
    await fs.writeFile(
      journalPath,
      [
        JSON.stringify(buildJournalEvent("ACTION_QUEUED", "act_001")),
        "{bad json}",
        JSON.stringify(buildJournalEvent("ACTION_STARTED", "act_001")),
        "",
      ].join("\n"),
      "utf8",
    );

    const journalRepository = new JournalRepository({ filePath: journalPath });

    await expect(journalRepository.list()).rejects.toMatchObject({
      name: "JournalStoreCorruptError",
      filePath: journalPath,
      lineNumber: 2,
    } satisfies Partial<JournalStoreCorruptError>);
  });
});
