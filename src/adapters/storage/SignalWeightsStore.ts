import { z } from "zod";

import {
  createDefaultSignalWeights,
  SignalWeightsSchema,
  type SignalWeights,
} from "../../domain/entities/SignalWeights.js";
import { TimestampSchema } from "../../domain/types/schemas.js";
import { FileStore, type FileStoreOptions } from "./FileStore.js";

export const SignalWeightsMetadataSchema = z
  .object({
    lastRecalibratedAt: TimestampSchema.optional(),
    positionsAtRecalibration: z.number().int().positive().optional(),
  })
  .strict();

export const SignalWeightsStoreFileSchema = z
  .object({
    weights: SignalWeightsSchema,
    metadata: SignalWeightsMetadataSchema.default({}),
  })
  .strict();

export type SignalWeightsStoreFile = z.infer<
  typeof SignalWeightsStoreFileSchema
>;

export interface SignalWeightsStoreOptions extends FileStoreOptions {
  filePath: string;
}

export interface SignalWeightsStore {
  load(): Promise<SignalWeights>;
  replace(
    weights: SignalWeights,
    metadata?: Partial<SignalWeightsStoreFile["metadata"]>,
  ): Promise<SignalWeights>;
  snapshot(): Promise<SignalWeightsStoreFile>;
  reset(): Promise<void>;
}

export class SignalWeightsStoreCorruptError extends Error {
  public constructor(filePath: string, details: string) {
    super(`Signal weights store is corrupt at ${filePath}: ${details}`);
    this.name = "SignalWeightsStoreCorruptError";
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
}

function emptyStore(): SignalWeightsStoreFile {
  return SignalWeightsStoreFileSchema.parse({
    weights: createDefaultSignalWeights(),
    metadata: {},
  });
}

function parseStore(
  raw: string | null,
  filePath: string,
): SignalWeightsStoreFile {
  if (raw === null) {
    return emptyStore();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SignalWeightsStoreCorruptError(
      filePath,
      error instanceof Error ? error.message : "invalid JSON",
    );
  }

  const validated = SignalWeightsStoreFileSchema.safeParse(parsed);
  if (!validated.success) {
    throw new SignalWeightsStoreCorruptError(
      filePath,
      formatZodError(validated.error),
    );
  }

  return validated.data;
}

export class FileSignalWeightsStore implements SignalWeightsStore {
  private readonly fileStore: FileStore;
  private readonly filePath: string;

  public constructor(options: SignalWeightsStoreOptions) {
    this.fileStore =
      options.fs === undefined
        ? new FileStore()
        : new FileStore({ fs: options.fs });
    this.filePath = options.filePath;
  }

  public async load(): Promise<SignalWeights> {
    const raw = await this.fileStore.readText(this.filePath);
    return parseStore(raw, this.filePath).weights;
  }

  public async replace(
    weights: SignalWeights,
    metadata: Partial<SignalWeightsStoreFile["metadata"]> = {},
  ): Promise<SignalWeights> {
    const validated = SignalWeightsSchema.parse(weights);
    const validatedMetadata =
      SignalWeightsMetadataSchema.partial().parse(metadata);
    await this.fileStore.updateTextAtomic(this.filePath, async (raw) => {
      const current = parseStore(raw, this.filePath);
      return JSON.stringify(
        SignalWeightsStoreFileSchema.parse({
          weights: validated,
          metadata: {
            ...current.metadata,
            ...validatedMetadata,
          },
        }),
        null,
        2,
      );
    });
    return this.load();
  }

  public async snapshot(): Promise<SignalWeightsStoreFile> {
    const raw = await this.fileStore.readText(this.filePath);
    return parseStore(raw, this.filePath);
  }

  public async reset(): Promise<void> {
    await this.fileStore.remove(this.filePath);
  }
}
