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

export interface JournalListOptions {
  repairTrailingLine?: boolean;
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
    const newLine = JSON.stringify(validated);

    await this.fileStore.updateTextAtomic(
      this.filePath,
      (raw) => {
        if (raw === null || raw.trimEnd().length === 0) {
          return `${newLine}\n`;
        }

        const rawLines = raw.split(/\r?\n/);
        let lastNonEmptyIndex = -1;
        for (let i = rawLines.length - 1; i >= 0; i--) {
          if ((rawLines[i] ?? "").trim().length > 0) {
            lastNonEmptyIndex = i;
            break;
          }
        }

        if (lastNonEmptyIndex === -1) {
          return `${newLine}\n`;
        }

        const lastLine = rawLines[lastNonEmptyIndex] ?? "";
        try {
          JournalEventSchema.parse(JSON.parse(lastLine));
          // Fast path: last line is valid, just append without re-serializing all events
          const base = raw.endsWith("\n") ? raw : `${raw}\n`;
          return `${base}${newLine}\n`;
        } catch (error) {
          // Corrupt trailing line — drop it and append
          const reason =
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "unknown parse failure";
          this.emitRecovery({
            type: "JOURNAL_TRAILING_LINE_SKIPPED",
            filePath: this.filePath,
            lineNumber: lastNonEmptyIndex + 1,
            reason,
          });
          const prefix = rawLines.slice(0, lastNonEmptyIndex).join("\n");
          const base = prefix.length > 0 ? `${prefix}\n` : "";
          return `${base}${newLine}\n`;
        }
      },
    );
  }


  public async list(options: JournalListOptions = {}): Promise<JournalEvent[]> {
    const raw = await this.fileStore.readText(this.filePath);
    if (raw === null) {
      return [];
    }

    const parsed = this.parseEvents(raw);

    if (options.repairTrailingLine === true && parsed.repaired) {
      await this.fileStore.updateTextAtomic(
        this.filePath,
        async (currentRaw) => {
          const currentParsed =
            currentRaw === null
              ? { events: [], repaired: false }
              : this.parseEvents(currentRaw);
          const contents =
            currentParsed.events.length === 0
              ? ""
              : `${currentParsed.events.map((e) => JSON.stringify(e)).join("\n")}\n`;
          return contents;
        },
      );

      return parsed.events;
    }

    return parsed.events;
  }

  public async validate(): Promise<void> {
    const raw = await this.fileStore.readText(this.filePath);
    if (raw === null) {
      return;
    }

    this.parseEvents(raw);
  }

  public async replaceAll(events: JournalEvent[]): Promise<void> {
    const validated = JournalEventSchema.array().parse(events);
    await this.rewriteValidEvents(validated);
  }

  private parseEvents(raw: string): {
    events: JournalEvent[];
    repaired: boolean;
  } {
    const rawLines = raw.split(/\r?\n/);
    const events: JournalEvent[] = [];
    let repaired = false;

    for (const [physicalIndex, rawLine] of rawLines.entries()) {
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }

      try {
        events.push(JournalEventSchema.parse(JSON.parse(line)));
      } catch (error) {
        const reason =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "unknown parse failure";
        const remainingLines = rawLines.slice(physicalIndex + 1);
        const isTrailingLine = remainingLines.every(
          (l) => l.trim().length === 0,
        );
        if (isTrailingLine) {
          repaired = true;
          this.emitRecovery({
            type: "JOURNAL_TRAILING_LINE_SKIPPED",
            filePath: this.filePath,
            lineNumber: physicalIndex + 1,
            reason,
          });
          continue;
        }

        throw new JournalStoreCorruptError(
          `journal file is corrupt at line ${physicalIndex + 1}: ${reason}`,
          this.filePath,
          physicalIndex + 1,
        );
      }
    }

    return { events, repaired };
  }

  private async rewriteValidEvents(events: JournalEvent[]): Promise<void> {
    const contents =
      events.length === 0
        ? ""
        : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    await this.fileStore.writeTextAtomic(this.filePath, contents);
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
