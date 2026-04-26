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
  beforeRequest(now: string): DetailRateLimitDecision;
  recordSuccess(now: string): void;
  recordRateLimited(input: { now: string; retryAfterMs?: number }): void;
  getCooldownUntil(): string | null;
  snapshot(): {
    requestCountInWindow: number;
    maxDetailRequestsPerWindow: number;
    cooldownUntil: string | null;
    lastRequestAt: string | null;
  };
}

export interface InMemoryMeteoraDetailRateLimiterOptions {
  detailRequestIntervalMs: number;
  maxDetailRequestsPerWindow: number;
  detailRequestWindowMs: number;
  detailCooldownAfter429Ms: number;
}

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

  public beforeRequest(now: string): DetailRateLimitDecision {
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

  public recordSuccess(now: string): void {
    const nowMs = parseTimestamp(now);
    this.prune(nowMs);
    this.requestTimestampsMs.push(nowMs);
    this.lastRequestAtMs = nowMs;
  }

  public recordRateLimited(input: {
    now: string;
    retryAfterMs?: number;
  }): void {
    const nowMs = parseTimestamp(input.now);
    const cooldownMs = Math.max(
      this.detailCooldownAfter429Ms,
      input.retryAfterMs ?? 0,
    );
    this.cooldownUntilMs = nowMs + cooldownMs;
    this.lastRequestAtMs = nowMs;
  }

  public getCooldownUntil(): string | null {
    return this.cooldownUntilMs === null ? null : toIso(this.cooldownUntilMs);
  }

  public snapshot(): ReturnType<MeteoraDetailRateLimiter["snapshot"]> {
    return {
      requestCountInWindow: this.requestTimestampsMs.length,
      maxDetailRequestsPerWindow: this.maxDetailRequestsPerWindow,
      cooldownUntil: this.getCooldownUntil(),
      lastRequestAt:
        this.lastRequestAtMs === null ? null : toIso(this.lastRequestAtMs),
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
