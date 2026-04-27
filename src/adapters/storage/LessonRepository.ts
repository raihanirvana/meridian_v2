import { z } from "zod";

import { LessonSchema, type Lesson } from "../../domain/entities/Lesson.js";
import { PerformanceRecordSchema } from "../../domain/entities/PerformanceRecord.js";

import { FileStore, type FileStoreOptions } from "./FileStore.js";

const LessonStoreFileSchema = z
  .object({
    lessons: LessonSchema.array(),
    performance: PerformanceRecordSchema.array(),
  })
  .strict();

type LessonStoreFile = z.infer<typeof LessonStoreFileSchema>;

export interface LessonRepositoryOptions extends FileStoreOptions {
  filePath: string;
}

export class LessonStoreCorruptError extends Error {
  public constructor(filePath: string, details: string) {
    super(`Lesson store is corrupt at ${filePath}: ${details}`);
    this.name = "LessonStoreCorruptError";
  }
}

function emptyStore(): LessonStoreFile {
  return {
    lessons: [],
    performance: [],
  };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
}

function parseStore(raw: string | null, filePath: string): LessonStoreFile {
  if (raw === null) {
    return emptyStore();
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
    throw new LessonStoreCorruptError(
      filePath,
      formatZodError(validated.error),
    );
  }

  return validated.data;
}

async function updateLessonStore(
  fileStore: FileStore,
  filePath: string,
  updater: (store: LessonStoreFile) => LessonStoreFile,
): Promise<void> {
  await fileStore.updateTextAtomic(filePath, async (raw) => {
    const updated = LessonStoreFileSchema.parse(
      updater(parseStore(raw, filePath)),
    );
    return JSON.stringify(updated, null, 2);
  });
}

export interface LessonRepositoryInterface {
  list(): Promise<Lesson[]>;
  append(lesson: Lesson): Promise<void>;
  appendIfAbsentDerived(lesson: Lesson): Promise<{
    inserted: boolean;
    lesson: Lesson;
  }>;
  update(id: string, patch: Partial<Lesson>): Promise<void>;
  remove(id: string): Promise<number>;
  clear(): Promise<number>;
  replaceAll(list: Lesson[]): Promise<void>;
}

export class FileLessonRepository implements LessonRepositoryInterface {
  private readonly fileStore: FileStore;
  private readonly filePath: string;

  public constructor(options: LessonRepositoryOptions) {
    this.fileStore = options.fs
      ? new FileStore({ fs: options.fs })
      : new FileStore();
    this.filePath = options.filePath;
  }

  public async list(): Promise<Lesson[]> {
    const raw = await this.fileStore.readText(this.filePath);
    return parseStore(raw, this.filePath).lessons;
  }

  public async append(lesson: Lesson): Promise<void> {
    const validated = LessonSchema.parse(lesson);
    await updateLessonStore(this.fileStore, this.filePath, (store) => ({
      ...store,
      lessons: [...store.lessons, validated].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      ),
    }));
  }

  public async appendIfAbsentDerived(lesson: Lesson): Promise<{
    inserted: boolean;
    lesson: Lesson;
  }> {
    const validated = LessonSchema.parse(lesson);
    let inserted = false;
    let resolvedLesson: Lesson = validated;

    await updateLessonStore(this.fileStore, this.filePath, (store) => {
      const existing = store.lessons.find(
        (current) =>
          current.rule === validated.rule &&
          current.pool === validated.pool &&
          current.context === validated.context &&
          current.pnlPct === validated.pnlPct &&
          current.rangeEfficiencyPct === validated.rangeEfficiencyPct &&
          current.outcome === validated.outcome,
      );
      if (existing !== undefined) {
        resolvedLesson = existing;
        inserted = false;
        return store;
      }

      inserted = true;
      resolvedLesson = validated;
      return {
        ...store,
        lessons: [...store.lessons, validated].sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id),
        ),
      };
    });

    return {
      inserted,
      lesson: resolvedLesson,
    };
  }

  public async update(id: string, patch: Partial<Lesson>): Promise<void> {
    await updateLessonStore(this.fileStore, this.filePath, (store) => ({
      ...store,
      lessons: store.lessons.map((lesson) =>
        lesson.id === id ? LessonSchema.parse({ ...lesson, ...patch }) : lesson,
      ),
    }));
  }

  public async remove(id: string): Promise<number> {
    let removed = 0;
    await updateLessonStore(this.fileStore, this.filePath, (store) => {
      const nextLessons = store.lessons.filter((lesson) => {
        const keep = lesson.id !== id;
        if (!keep) {
          removed += 1;
        }
        return keep;
      });

      return {
        ...store,
        lessons: nextLessons,
      };
    });
    return removed;
  }

  public async clear(): Promise<number> {
    const existing = await this.list();
    await updateLessonStore(this.fileStore, this.filePath, (store) => ({
      ...store,
      lessons: [],
    }));
    return existing.length;
  }

  public async replaceAll(list: Lesson[]): Promise<void> {
    const validated = LessonSchema.array().parse(list);
    await updateLessonStore(this.fileStore, this.filePath, (store) => ({
      ...store,
      lessons: [...validated].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      ),
    }));
  }
}

export { LessonStoreFileSchema, type LessonStoreFile };
