import {
  JournalEventSchema,
  type JournalEvent,
} from "../../domain/entities/JournalEvent.js";

import { FileStore, type FileStoreOptions } from "./FileStore.js";

export interface JournalRepositoryOptions extends FileStoreOptions {
  filePath: string;
}

export class JournalRepository {
  private readonly fileStore: FileStore;
  private readonly filePath: string;

  public constructor(options: JournalRepositoryOptions) {
    this.fileStore = options.fs
      ? new FileStore({ fs: options.fs })
      : new FileStore();
    this.filePath = options.filePath;
  }

  public async append(event: JournalEvent): Promise<void> {
    const validated = JournalEventSchema.parse(event);
    await this.fileStore.appendLine(this.filePath, JSON.stringify(validated));
  }

  public async list(): Promise<JournalEvent[]> {
    const raw = await this.fileStore.readText(this.filePath);
    if (raw === null) {
      return [];
    }

    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JournalEventSchema.parse(JSON.parse(line))];
        } catch {
          return [];
        }
      });
  }
}
