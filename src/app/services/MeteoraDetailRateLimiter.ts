import { z } from "zod";

import {
  FileStore,
  type FileStoreOptions,
} from "../../adapters/storage/FileStore.js";

export type DetailRateLimitDecision =
  | {
      allowed: true;
      waitMs: number;
    }
  | {
      allowed: false;
      reason: "window_budget_exhausted" | "endpoint_cooldown_active";
      retryAfterMs: number;
    };

export interface MeteoraDetailRateLimiter {
  beforeRequest(now: string): Promise<DetailRateLimitDecision>;
  recordAttempt(now: string): Promise<void>;
  recordSuccess(now: string): Promise<void>;
  recordFailure(now: string): Promise<void>;
  recordRateLimited(input: {
    now: string;
    retryAfterMs?: number;
  }): Promise<void>;
  getCooldownUntil(): Promise<string | null>;
  snapshot(): Promise<{
    requestCountInWindow: number;
    maxDetailRequestsPerWindow: number;
    cooldownUntil: string | null;
    lastRequestAt: string | null;
  }>;
}

export interface InMemoryMeteoraDetailRateLimiterOptions {
  detailRequestIntervalMs: number;
  maxDetailRequestsPerWindow: number;
  detailRequestWindowMs: number;
  detailCooldownAfter429Ms: number;
}

export interface FileMeteoraDetailRateLimiterOptions
  extends InMemoryMeteoraDetailRateLimiterOptions, FileStoreOptions {
  filePath: string;
}

const PersistedMeteoraDetailRateLimitStateSchema = z
  .object({
    recentRequestTimestamps: z.array(z.string().datetime()).default([]),
    cooldownUntil: z.string().datetime().nullable().default(null),
    lastRequestAt: z.string().datetime().nullable().default(null),
  })
  .strict();

type PersistedMeteoraDetailRateLimitState = z.infer<
  typeof PersistedMeteoraDetailRateLimitStateSchema
>;

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid ISO timestamp for detail rate limiter: ${value}`);
  }
  return parsed;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export class InMemoryMeteoraDetailRateLimiter implements MeteoraDetailRateLimiter {
  private readonly detailRequestIntervalMs: number;
  private readonly maxDetailRequestsPerWindow: number;
  private readonly detailRequestWindowMs: number;
  private readonly detailCooldownAfter429Ms: number;
  private readonly requestTimestampsMs: number[] = [];
  private cooldownUntilMs: number | null = null;
  private lastRequestAtMs: number | null = null;

  public constructor(options: InMemoryMeteoraDetailRateLimiterOptions) {
    this.detailRequestIntervalMs = Math.max(0, options.detailRequestIntervalMs);
    this.maxDetailRequestsPerWindow = Math.max(
      1,
      options.maxDetailRequestsPerWindow,
    );
    this.detailRequestWindowMs = Math.max(1, options.detailRequestWindowMs);
    this.detailCooldownAfter429Ms = Math.max(
      1,
      options.detailCooldownAfter429Ms,
    );
  }

  public async beforeRequest(now: string): Promise<DetailRateLimitDecision> {
    const nowMs = parseTimestamp(now);
    this.prune(nowMs);

    if (this.cooldownUntilMs !== null && this.cooldownUntilMs > nowMs) {
      return {
        allowed: false,
        reason: "endpoint_cooldown_active",
        retryAfterMs: this.cooldownUntilMs - nowMs,
      };
    }

    if (this.requestTimestampsMs.length >= this.maxDetailRequestsPerWindow) {
      const oldest = this.requestTimestampsMs[0] as number;
      return {
        allowed: false,
        reason: "window_budget_exhausted",
        retryAfterMs: Math.max(0, oldest + this.detailRequestWindowMs - nowMs),
      };
    }

    const waitMs =
      this.lastRequestAtMs === null
        ? 0
        : Math.max(
            0,
            this.lastRequestAtMs + this.detailRequestIntervalMs - nowMs,
          );
    return { allowed: true, waitMs };
  }

  public async recordAttempt(now: string): Promise<void> {
    const nowMs = parseTimestamp(now);
    this.prune(nowMs);
    this.requestTimestampsMs.push(nowMs);
    this.lastRequestAtMs = nowMs;
  }

  public async recordSuccess(now: string): Promise<void> {
    const nowMs = parseTimestamp(now);
    this.prune(nowMs);
  }

  public async recordFailure(now: string): Promise<void> {
    const nowMs = parseTimestamp(now);
    this.prune(nowMs);
  }

  public async recordRateLimited(input: {
    now: string;
    retryAfterMs?: number;
  }): Promise<void> {
    const nowMs = parseTimestamp(input.now);
    const cooldownMs = Math.max(
      this.detailCooldownAfter429Ms,
      input.retryAfterMs ?? 0,
    );
    this.cooldownUntilMs = nowMs + cooldownMs;
    this.lastRequestAtMs = nowMs;
  }

  public async getCooldownUntil(): Promise<string | null> {
    return this.cooldownUntilMs === null ? null : toIso(this.cooldownUntilMs);
  }

  public async snapshot(): Promise<
    Awaited<ReturnType<MeteoraDetailRateLimiter["snapshot"]>>
  > {
    return {
      requestCountInWindow: this.requestTimestampsMs.length,
      maxDetailRequestsPerWindow: this.maxDetailRequestsPerWindow,
      cooldownUntil:
        this.cooldownUntilMs === null ? null : toIso(this.cooldownUntilMs),
      lastRequestAt:
        this.lastRequestAtMs === null ? null : toIso(this.lastRequestAtMs),
    };
  }

  protected restoreState(input: {
    requestTimestampsMs: number[];
    cooldownUntilMs: number | null;
    lastRequestAtMs: number | null;
    nowMs?: number;
  }): void {
    this.requestTimestampsMs.splice(
      0,
      this.requestTimestampsMs.length,
      ...input.requestTimestampsMs,
    );
    this.cooldownUntilMs = input.cooldownUntilMs;
    this.lastRequestAtMs = input.lastRequestAtMs;
    if (input.nowMs !== undefined) {
      this.prune(input.nowMs);
    }
  }

  protected exportState(): {
    requestTimestampsMs: number[];
    cooldownUntilMs: number | null;
    lastRequestAtMs: number | null;
  } {
    return {
      requestTimestampsMs: [...this.requestTimestampsMs],
      cooldownUntilMs: this.cooldownUntilMs,
      lastRequestAtMs: this.lastRequestAtMs,
    };
  }

  private prune(nowMs: number): void {
    while (
      this.requestTimestampsMs.length > 0 &&
      (this.requestTimestampsMs[0] as number) + this.detailRequestWindowMs <=
        nowMs
    ) {
      this.requestTimestampsMs.shift();
    }

    if (this.cooldownUntilMs !== null && this.cooldownUntilMs <= nowMs) {
      this.cooldownUntilMs = null;
    }
  }
}

export class FileMeteoraDetailRateLimiter
  extends InMemoryMeteoraDetailRateLimiter
  implements MeteoraDetailRateLimiter
{
  private readonly filePath: string;
  private readonly fileStore: FileStore;

  public constructor(options: FileMeteoraDetailRateLimiterOptions) {
    super(options);
    this.filePath = options.filePath;
    this.fileStore =
      options.fs === undefined
        ? new FileStore()
        : new FileStore({ fs: options.fs });
  }

  public override async beforeRequest(
    now: string,
  ): Promise<DetailRateLimitDecision> {
    await this.load(now);
    return super.beforeRequest(now);
  }

  public override async recordAttempt(now: string): Promise<void> {
    await this.load(now);
    await super.recordAttempt(now);
    await this.persist(now);
  }

  public override async recordSuccess(now: string): Promise<void> {
    await this.load(now);
    await super.recordSuccess(now);
    await this.persist(now);
  }

  public override async recordFailure(now: string): Promise<void> {
    await this.load(now);
    await super.recordFailure(now);
    await this.persist(now);
  }

  public override async recordRateLimited(input: {
    now: string;
    retryAfterMs?: number;
  }): Promise<void> {
    await this.load(input.now);
    await super.recordRateLimited(input);
    await this.persist(input.now);
  }

  public override async getCooldownUntil(): Promise<string | null> {
    await this.load();
    return super.getCooldownUntil();
  }

  public override async snapshot(): Promise<
    Awaited<ReturnType<MeteoraDetailRateLimiter["snapshot"]>>
  > {
    await this.load();
    return super.snapshot();
  }

  private async load(now?: string): Promise<void> {
    const raw = await this.fileStore.readText(this.filePath);
    if (raw === null) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const validated =
      PersistedMeteoraDetailRateLimitStateSchema.safeParse(parsed);
    if (!validated.success) {
      return;
    }

    this.restoreState({
      requestTimestampsMs:
        validated.data.recentRequestTimestamps.map(parseTimestamp),
      cooldownUntilMs:
        validated.data.cooldownUntil === null
          ? null
          : parseTimestamp(validated.data.cooldownUntil),
      lastRequestAtMs:
        validated.data.lastRequestAt === null
          ? null
          : parseTimestamp(validated.data.lastRequestAt),
      ...(now === undefined ? {} : { nowMs: parseTimestamp(now) }),
    });
  }

  private async persist(now: string): Promise<void> {
    const nowMs = parseTimestamp(now);
    this.restoreState({ ...this.exportState(), nowMs });
    const state = this.exportState();
    const persisted: PersistedMeteoraDetailRateLimitState =
      PersistedMeteoraDetailRateLimitStateSchema.parse({
        recentRequestTimestamps: state.requestTimestampsMs.map(toIso),
        cooldownUntil:
          state.cooldownUntilMs === null ? null : toIso(state.cooldownUntilMs),
        lastRequestAt:
          state.lastRequestAtMs === null ? null : toIso(state.lastRequestAtMs),
      });
    await this.fileStore.writeTextAtomic(
      this.filePath,
      JSON.stringify(persisted, null, 2),
    );
  }
}
