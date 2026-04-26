import {
  JournalEventSchema,
  type JournalEvent,
} from "../../domain/entities/JournalEvent.js";

import { FileStore, type FileStoreOptions } from "./FileStore.js";

export interface JournalRecoveryEvent {
  type: "JOURNAL_TRAILING_LINE_SKIPPED";
  filePath: string;
  lineNumber: number;
  reason: string;
}

export type JournalRecoveryListener = (event: JournalRecoveryEvent) => void;

export interface JournalRepositoryOptions extends FileStoreOptions {
  filePath: string;
  onRecovery?: JournalRecoveryListener;
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
  private readonly onRecovery: JournalRecoveryListener | null;

  public constructor(options: JournalRepositoryOptions) {
    this.fileStore = options.fs
      ? new FileStore({ fs: options.fs })
      : new FileStore();
    this.filePath = options.filePath;
    this.onRecovery = options.onRecovery ?? null;
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
        const reason =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "unknown parse failure";
        const isTrailingLine = index === lines.length - 1;
        if (isTrailingLine) {
          this.emitRecovery({
            type: "JOURNAL_TRAILING_LINE_SKIPPED",
            filePath: this.filePath,
            lineNumber: index + 1,
            reason,
          });
          continue;
        }

        throw new JournalStoreCorruptError(
          `journal file is corrupt at line ${index + 1}: ${reason}`,
          this.filePath,
          index + 1,
        );
      }
    }

    return events;
  }

  private emitRecovery(event: JournalRecoveryEvent): void {
    if (this.onRecovery === null) {
      return;
    }
    try {
      this.onRecovery(event);
    } catch {
      // Recovery listeners must never block journal reads.
    }
  }
}
