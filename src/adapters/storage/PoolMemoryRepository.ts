import { z } from "zod";

import {
  PoolMemoryEntrySchema,
  type PoolMemoryEntry,
} from "../../domain/entities/PoolMemory.js";

import { FileStore, type FileStoreOptions } from "./FileStore.js";

export const PoolMemoryStoreSchema = z.record(
  z.string().min(1),
  PoolMemoryEntrySchema,
);

export type PoolMemoryStore = z.infer<typeof PoolMemoryStoreSchema>;

export interface PoolMemoryRepositoryOptions extends FileStoreOptions {
  filePath: string;
}

export class PoolMemoryStoreCorruptError extends Error {
  public constructor(filePath: string, details: string) {
    super(`Pool memory store is corrupt at ${filePath}: ${details}`);
    this.name = "PoolMemoryStoreCorruptError";
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
}

function parseStore(raw: string | null, filePath: string): PoolMemoryStore {
  if (raw === null) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PoolMemoryStoreCorruptError(
      filePath,
      error instanceof Error ? error.message : "invalid JSON",
    );
  }

  const validated = PoolMemoryStoreSchema.safeParse(parsed);
  if (!validated.success) {
    throw new PoolMemoryStoreCorruptError(filePath, formatZodError(validated.error));
  }

  return validated.data;
}

export interface PoolMemoryRepository {
  get(poolAddress: string): Promise<PoolMemoryEntry | null>;
  upsert(
    poolAddress: string,
    patcher: (current: PoolMemoryEntry | null) => PoolMemoryEntry,
  ): Promise<PoolMemoryEntry>;
  listAll(): Promise<PoolMemoryEntry[]>;
  addNote(poolAddress: string, note: string, addedAt: string): Promise<PoolMemoryEntry>;
  setCooldown(poolAddress: string, untilIso: string | null): Promise<PoolMemoryEntry>;
}

function defaultEntry(poolAddress: string): PoolMemoryEntry {
  return PoolMemoryEntrySchema.parse({
    poolAddress,
    name: poolAddress.slice(0, 8),
    baseMint: null,
    totalDeploys: 0,
    deploys: [],
    avgPnlPct: 0,
    winRatePct: 0,
    lastDeployedAt: null,
    lastOutcome: null,
    notes: [],
    snapshots: [],
  });
}

export class FilePoolMemoryRepository implements PoolMemoryRepository {
  private readonly fileStore: FileStore;
  private readonly filePath: string;

  public constructor(options: PoolMemoryRepositoryOptions) {
    this.fileStore = options.fs
      ? new FileStore({ fs: options.fs })
      : new FileStore();
    this.filePath = options.filePath;
  }

  public async get(poolAddress: string): Promise<PoolMemoryEntry | null> {
    const raw = await this.fileStore.readText(this.filePath);
    const store = parseStore(raw, this.filePath);
    return store[poolAddress] ?? null;
  }

  public async upsert(
    poolAddress: string,
    patcher: (current: PoolMemoryEntry | null) => PoolMemoryEntry,
  ): Promise<PoolMemoryEntry> {
    let updatedEntry: PoolMemoryEntry | null = null;

    await this.fileStore.updateTextAtomic(this.filePath, async (raw) => {
      const store = parseStore(raw, this.filePath);
      const nextEntry = PoolMemoryEntrySchema.parse(
        patcher(store[poolAddress] ?? null),
      );
      updatedEntry = nextEntry;
      return JSON.stringify(
        PoolMemoryStoreSchema.parse({
          ...store,
          [poolAddress]: nextEntry,
        }),
        null,
        2,
      );
    });

    return updatedEntry ?? defaultEntry(poolAddress);
  }

  public async listAll(): Promise<PoolMemoryEntry[]> {
    const raw = await this.fileStore.readText(this.filePath);
    return Object.values(parseStore(raw, this.filePath)).sort((left, right) =>
      left.poolAddress.localeCompare(right.poolAddress),
    );
  }

  public async addNote(
    poolAddress: string,
    note: string,
    addedAt: string,
  ): Promise<PoolMemoryEntry> {
    return this.upsert(poolAddress, (current) =>
      PoolMemoryEntrySchema.parse({
        ...(current ?? defaultEntry(poolAddress)),
        notes: [
          ...(current?.notes ?? []),
          {
            note,
            addedAt,
          },
        ],
      }),
    );
  }

  public async setCooldown(
    poolAddress: string,
    untilIso: string | null,
  ): Promise<PoolMemoryEntry> {
    return this.upsert(poolAddress, (current) => {
      const base = { ...(current ?? defaultEntry(poolAddress)) };
      if (untilIso === null) {
        delete (base as { cooldownUntil?: string }).cooldownUntil;
      } else {
        (base as { cooldownUntil?: string }).cooldownUntil = untilIso;
      }

      return PoolMemoryEntrySchema.parse(base);
    });
  }
}
