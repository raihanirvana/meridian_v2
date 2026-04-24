import {
  JournalEventSchema,
  type JournalEvent,
} from "../../domain/entities/JournalEvent.js";

import { FileStore, type FileStoreOptions } from "./FileStore.js";

export interface JournalRepositoryOptions extends FileStoreOptions {
  filePath: string;
}

export class JournalStoreCorruptError extends Error {
  public constructor(
    message: string,
    public readonly filePath: string,
    public readonly lineNumber: number,
  ) {
    super(message);
    this.name = "JournalStoreCorruptError";
  }
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

    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const events: JournalEvent[] = [];
    for (const [index, line] of lines.entries()) {
      try {
        events.push(JournalEventSchema.parse(JSON.parse(line)));
      } catch (error) {
        const isTrailingLine = index === lines.length - 1;
        if (isTrailingLine) {
          continue;
        }

        const reason =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "unknown parse failure";
        throw new JournalStoreCorruptError(
          `journal file is corrupt at line ${index + 1}: ${reason}`,
          this.filePath,
          index + 1,
        );
      }
    }

    return events;
  }
}
