import {
  PerformanceRecordSchema,
  type PerformanceRecord,
} from "../../domain/entities/PerformanceRecord.js";

import {
  FileLessonRepository,
  LessonStoreFileSchema,
  LessonStoreCorruptError,
  type LessonRepositoryOptions,
} from "./LessonRepository.js";
import { FileStore } from "./FileStore.js";

export type PerformanceRepositoryOptions = LessonRepositoryOptions;

export interface PerformanceSummary {
  totalPositionsClosed: number;
  totalPnlUsd: number;
  avgPnlPct: number;
  winRatePct: number;
}

export interface PerformanceRepositoryInterface {
  append(record: PerformanceRecord): Promise<void>;
  list(input?: {
    sinceIso?: string;
    limit?: number;
  }): Promise<PerformanceRecord[]>;
  summary(): Promise<PerformanceSummary>;
  clear(): Promise<number>;
}

function parseStore(raw: string | null, filePath: string) {
  if (raw === null) {
    return LessonStoreFileSchema.parse({
      lessons: [],
      performance: [],
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new LessonStoreCorruptError(
      filePath,
      error instanceof Error ? error.message : "invalid JSON",
    );
  }

  const validated = LessonStoreFileSchema.safeParse(parsed);
  if (!validated.success) {
    throw new LessonStoreCorruptError(filePath, validated.error.message);
  }

  return validated.data;
}

export class FilePerformanceRepository implements PerformanceRepositoryInterface {
  private readonly fileStore: FileStore;
  private readonly filePath: string;

  public constructor(options: PerformanceRepositoryOptions) {
    this.fileStore = options.fs
      ? new FileStore({ fs: options.fs })
      : new FileStore();
    this.filePath = options.filePath;
  }

  public async append(record: PerformanceRecord): Promise<void> {
    const validated = PerformanceRecordSchema.parse(record);
    await this.fileStore.updateTextAtomic(this.filePath, async (raw) => {
      const store = parseStore(raw, this.filePath);
      const next = LessonStoreFileSchema.parse({
        ...store,
        performance: [...store.performance, validated].sort((left, right) =>
          left.recordedAt.localeCompare(right.recordedAt) ||
          left.positionId.localeCompare(right.positionId),
        ),
      });
      return JSON.stringify(next, null, 2);
    });
  }

  public async list(input: {
    sinceIso?: string;
    limit?: number;
  } = {}): Promise<PerformanceRecord[]> {
    const raw = await this.fileStore.readText(this.filePath);
    const performance = parseStore(raw, this.filePath).performance;
    const filtered = input.sinceIso === undefined
      ? performance
      : performance.filter((record) => record.recordedAt >= input.sinceIso!);
    const limited = input.limit === undefined
      ? filtered
      : filtered.slice(Math.max(filtered.length - input.limit, 0));

    return limited;
  }

  public async summary(): Promise<PerformanceSummary> {
    const performance = await this.list();
    const totalPnlUsd = performance.reduce((sum, record) => sum + record.pnlUsd, 0);
    const totalPnlPct = performance.reduce((sum, record) => sum + record.pnlPct, 0);
    const wins = performance.filter((record) => record.pnlPct > 0).length;

    return {
      totalPositionsClosed: performance.length,
      totalPnlUsd,
      avgPnlPct: performance.length === 0 ? 0 : totalPnlPct / performance.length,
      winRatePct: performance.length === 0 ? 0 : (wins / performance.length) * 100,
    };
  }

  public async clear(): Promise<number> {
    const existing = await this.list();
    await this.fileStore.updateTextAtomic(this.filePath, async (raw) => {
      const store = parseStore(raw, this.filePath);
      const next = LessonStoreFileSchema.parse({
        ...store,
        performance: [],
      });
      return JSON.stringify(next, null, 2);
    });
    return existing.length;
  }
}

export { FileLessonRepository };
