import { z } from "zod";

import { TimestampSchema } from "../../domain/types/schemas.js";
import { FileStore, type FileStoreOptions } from "./FileStore.js";

export const RuntimeDeployControlSchema = z
  .object({
    active: z.boolean(),
    reason: z.string().min(1).optional(),
    updatedAt: TimestampSchema.optional(),
  })
  .strict();

export const RuntimeControlStoreFileSchema = z
  .object({
    stopAllDeploys: RuntimeDeployControlSchema.default({
      active: false,
    }),
  })
  .strict();

export type RuntimeDeployControl = z.infer<typeof RuntimeDeployControlSchema>;
export type RuntimeControlStoreFile = z.infer<typeof RuntimeControlStoreFileSchema>;

export interface RuntimeControlStore {
  snapshot(): Promise<RuntimeControlStoreFile>;
  tripStopAllDeploys(input: { reason?: string; updatedAt: string }): Promise<RuntimeDeployControl>;
  clearStopAllDeploys(updatedAt: string): Promise<RuntimeDeployControl>;
}

export interface RuntimeControlStoreOptions extends FileStoreOptions {
  filePath: string;
}

export class RuntimeControlStoreCorruptError extends Error {
  public constructor(filePath: string, details: string) {
    super(`Runtime control store is corrupt at ${filePath}: ${details}`);
    this.name = "RuntimeControlStoreCorruptError";
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
}

function parseStore(raw: string | null, filePath: string): RuntimeControlStoreFile {
  if (raw === null) {
    return RuntimeControlStoreFileSchema.parse({
      stopAllDeploys: { active: false },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RuntimeControlStoreCorruptError(
      filePath,
      error instanceof Error ? error.message : "invalid JSON",
    );
  }

  const validated = RuntimeControlStoreFileSchema.safeParse(parsed);
  if (!validated.success) {
    throw new RuntimeControlStoreCorruptError(filePath, formatZodError(validated.error));
  }

  return validated.data;
}

export class FileRuntimeControlStore implements RuntimeControlStore {
  private readonly fileStore: FileStore;
  private readonly filePath: string;

  public constructor(options: RuntimeControlStoreOptions) {
    this.fileStore = options.fs === undefined
      ? new FileStore()
      : new FileStore({ fs: options.fs });
    this.filePath = options.filePath;
  }

  public async snapshot(): Promise<RuntimeControlStoreFile> {
    const raw = await this.fileStore.readText(this.filePath);
    return parseStore(raw, this.filePath);
  }

  public async tripStopAllDeploys(input: {
    reason?: string;
    updatedAt: string;
  }): Promise<RuntimeDeployControl> {
    let snapshot: RuntimeDeployControl | null = null;
    await this.fileStore.updateTextAtomic(this.filePath, async (raw) => {
      const current = parseStore(raw, this.filePath);
      const next = RuntimeControlStoreFileSchema.parse({
        ...current,
        stopAllDeploys: {
          active: true,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          updatedAt: input.updatedAt,
        },
      });
      snapshot = next.stopAllDeploys;
      return JSON.stringify(next, null, 2);
    });

    return RuntimeDeployControlSchema.parse(snapshot);
  }

  public async clearStopAllDeploys(updatedAt: string): Promise<RuntimeDeployControl> {
    let snapshot: RuntimeDeployControl | null = null;
    await this.fileStore.updateTextAtomic(this.filePath, async (raw) => {
      const current = parseStore(raw, this.filePath);
      const next = RuntimeControlStoreFileSchema.parse({
        ...current,
        stopAllDeploys: {
          active: false,
          updatedAt,
        },
      });
      snapshot = next.stopAllDeploys;
      return JSON.stringify(next, null, 2);
    });

    return RuntimeDeployControlSchema.parse(snapshot);
  }
}
