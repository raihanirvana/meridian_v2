import { z } from "zod";

import {
  ScreeningPolicySchema,
  type ScreeningPolicy,
} from "../../domain/rules/screeningRules.js";
import { TimestampSchema } from "../../domain/types/schemas.js";
import { FileStore, type FileStoreOptions } from "../storage/FileStore.js";

export const PolicyOverridesSchema = z
  .object({
    minFeeActiveTvlRatio: z.number().positive().optional(),
    minOrganic: z.number().min(0).max(100).optional(),
  })
  .strict();

export const RuntimePolicyMetadataSchema = z
  .object({
    lastEvolvedAt: TimestampSchema.optional(),
    positionsAtEvolution: z.number().int().positive().optional(),
    rationale: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const RuntimePolicyStoreFileSchema = z
  .object({
    overrides: PolicyOverridesSchema.default({}),
    metadata: RuntimePolicyMetadataSchema.default({ rationale: {} }),
  })
  .strict();

export type PolicyOverrides = z.infer<typeof PolicyOverridesSchema>;
export type RuntimePolicyMetadata = z.infer<typeof RuntimePolicyMetadataSchema>;
export type RuntimePolicyStoreFile = z.infer<
  typeof RuntimePolicyStoreFileSchema
>;

export interface RuntimePolicyStoreSnapshot {
  policy: ScreeningPolicy;
  overrides: PolicyOverrides;
  lastEvolvedAt?: string;
  positionsAtEvolution?: number;
  rationale: Record<string, string>;
}

export interface RuntimePolicyStore {
  loadOverrides(): Promise<PolicyOverrides>;
  applyOverrides(
    patch: Partial<PolicyOverrides>,
    metadata?: Partial<RuntimePolicyMetadata>,
  ): Promise<PolicyOverrides>;
  snapshot(): Promise<RuntimePolicyStoreSnapshot>;
  reset(): Promise<void>;
}

export interface FileRuntimePolicyStoreOptions extends FileStoreOptions {
  filePath: string;
  basePolicy: ScreeningPolicy;
}

export class PolicyStoreCorruptError extends Error {
  public constructor(filePath: string, details: string) {
    super(`Runtime policy store is corrupt at ${filePath}: ${details}`);
    this.name = "PolicyStoreCorruptError";
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
}

function emptyStore(): RuntimePolicyStoreFile {
  return RuntimePolicyStoreFileSchema.parse({
    overrides: {},
    metadata: {
      rationale: {},
    },
  });
}

function parseStore(
  raw: string | null,
  filePath: string,
): RuntimePolicyStoreFile {
  if (raw === null) {
    return emptyStore();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PolicyStoreCorruptError(
      filePath,
      error instanceof Error ? error.message : "invalid JSON",
    );
  }

  const validated = RuntimePolicyStoreFileSchema.safeParse(parsed);
  if (!validated.success) {
    throw new PolicyStoreCorruptError(
      filePath,
      formatZodError(validated.error),
    );
  }

  return validated.data;
}

function mergePolicy(
  basePolicy: ScreeningPolicy,
  overrides: PolicyOverrides,
): ScreeningPolicy {
  return ScreeningPolicySchema.parse({
    ...basePolicy,
    ...overrides,
  });
}

export class FileRuntimePolicyStore implements RuntimePolicyStore {
  private readonly fileStore: FileStore;
  private readonly filePath: string;
  private readonly basePolicy: ScreeningPolicy;

  public constructor(options: FileRuntimePolicyStoreOptions) {
    this.fileStore = options.fs
      ? new FileStore({ fs: options.fs })
      : new FileStore();
    this.filePath = options.filePath;
    this.basePolicy = ScreeningPolicySchema.parse(options.basePolicy);
  }

  public async loadOverrides(): Promise<PolicyOverrides> {
    const raw = await this.fileStore.readText(this.filePath);
    return parseStore(raw, this.filePath).overrides;
  }

  public async applyOverrides(
    patch: Partial<PolicyOverrides>,
    metadata: Partial<RuntimePolicyMetadata> = {},
  ): Promise<PolicyOverrides> {
    const validatedPatch = PolicyOverridesSchema.partial().parse(patch);

    await this.fileStore.updateTextAtomic(this.filePath, async (raw) => {
      const current = parseStore(raw, this.filePath);
      const nextOverrides = PolicyOverridesSchema.parse({
        ...current.overrides,
        ...validatedPatch,
      });
      const next = RuntimePolicyStoreFileSchema.parse({
        overrides: nextOverrides,
        metadata: {
          ...current.metadata,
          ...metadata,
          rationale: metadata.rationale ?? current.metadata.rationale,
        },
      });
      return JSON.stringify(next, null, 2);
    });

    return this.loadOverrides();
  }

  public async snapshot(): Promise<RuntimePolicyStoreSnapshot> {
    const raw = await this.fileStore.readText(this.filePath);
    const store = parseStore(raw, this.filePath);

    return {
      policy: mergePolicy(this.basePolicy, store.overrides),
      overrides: store.overrides,
      ...(store.metadata.lastEvolvedAt === undefined
        ? {}
        : { lastEvolvedAt: store.metadata.lastEvolvedAt }),
      ...(store.metadata.positionsAtEvolution === undefined
        ? {}
        : { positionsAtEvolution: store.metadata.positionsAtEvolution }),
      rationale: store.metadata.rationale,
    };
  }

  public async reset(): Promise<void> {
    await this.fileStore.remove(this.filePath);
  }
}
