import {
  PositionSchema,
  type Position,
} from "../../domain/entities/Position.js";

import { FileStore, type FileStoreOptions } from "./FileStore.js";

export interface StateRepositoryOptions extends FileStoreOptions {
  filePath: string;
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

    return PositionSchema.array().parse(JSON.parse(raw));
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
      const positions =
        raw === null ? [] : PositionSchema.array().parse(JSON.parse(raw));
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
