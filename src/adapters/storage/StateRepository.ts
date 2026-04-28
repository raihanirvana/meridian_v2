import {
  PositionSchema,
  type Position,
} from "../../domain/entities/Position.js";

import { FileStore, type FileStoreOptions } from "./FileStore.js";

export interface StateRepositoryOptions extends FileStoreOptions {
  filePath: string;
}

export class StateStoreCorruptError extends Error {
  public constructor(
    message: string,
    public readonly filePath: string,
    public override readonly cause: unknown,
  ) {
    super(message);
    this.name = "StateStoreCorruptError";
  }
}

function migratePosition(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const pos = raw as Record<string, unknown>;
  let migrated = pos;

  if (
    migrated["peakPnlPct"] !== undefined &&
    migrated["peakPnlPct"] !== null &&
    migrated["peakPnlRecordedAt"] == null
  ) {
    const fallback =
      typeof migrated["lastSyncedAt"] === "string"
        ? migrated["lastSyncedAt"]
        : typeof migrated["openedAt"] === "string"
          ? migrated["openedAt"]
          : null;
    migrated =
      fallback !== null
        ? { ...migrated, peakPnlRecordedAt: fallback }
        : { ...migrated, peakPnlPct: null, peakPnlRecordedAt: null };
  }

  if (migrated["peakPnlPct"] == null && migrated["peakPnlRecordedAt"] != null) {
    migrated = { ...migrated, peakPnlRecordedAt: null };
  }

  return migrated;
}

function parsePositions(raw: string, filePath: string): Position[] {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    const reason =
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "unknown JSON parse failure";
    throw new StateStoreCorruptError(
      `state file is corrupt (invalid JSON): ${reason}`,
      filePath,
      error,
    );
  }

  const migrated = Array.isArray(parsedJson)
    ? parsedJson.map(migratePosition)
    : parsedJson;

  const result = PositionSchema.array().safeParse(migrated);
  if (!result.success) {
    throw new StateStoreCorruptError(
      `state file is corrupt (schema mismatch): ${result.error.message}`,
      filePath,
      result.error,
    );
  }

  return result.data;
}

export class StateRepository {
  private readonly fileStore: FileStore;
  private readonly filePath: string;

  public constructor(options: StateRepositoryOptions) {
    this.fileStore = options.fs
      ? new FileStore({ fs: options.fs })
      : new FileStore();
    this.filePath = options.filePath;
  }

  public async list(): Promise<Position[]> {
    const raw = await this.fileStore.readText(this.filePath);
    if (raw === null) {
      return [];
    }

    return parsePositions(raw, this.filePath);
  }

  public async get(positionId: string): Promise<Position | null> {
    const positions = await this.list();
    return (
      positions.find((position) => position.positionId === positionId) ?? null
    );
  }

  public async upsert(position: Position): Promise<void> {
    const validated = PositionSchema.parse(position);
    await this.fileStore.updateTextAtomic(this.filePath, async (raw) => {
      const positions = raw === null ? [] : parsePositions(raw, this.filePath);
      const nextPositions = positions.filter(
        (currentPosition) =>
          currentPosition.positionId !== validated.positionId,
      );
      nextPositions.push(validated);

      const stableOrder = [...PositionSchema.array().parse(nextPositions)].sort(
        (left, right) => left.positionId.localeCompare(right.positionId),
      );

      return JSON.stringify(stableOrder, null, 2);
    });
  }

  public async replaceAll(positions: Position[]): Promise<void> {
    const validated = PositionSchema.array().parse(positions);
    const stableOrder = [...validated].sort((left, right) =>
      left.positionId.localeCompare(right.positionId),
    );

    await this.fileStore.writeTextAtomic(
      this.filePath,
      JSON.stringify(stableOrder, null, 2),
    );
  }
}
