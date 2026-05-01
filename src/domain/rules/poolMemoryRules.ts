import {
  PoolDeploySchema,
  PoolMemoryEntrySchema,
  type PoolDeploy,
  type PoolMemoryEntry,
} from "../entities/PoolMemory.js";
import { type CloseReason } from "../types/enums.js";

export function computePoolAggregates(deploys: PoolDeploy[]): {
  totalDeploys: number;
  avgPnlPct: number;
  winRatePct: number;
  lastOutcome: "profit" | "loss" | null;
  lastDeployedAt: string | null;
} {
  const validated = PoolDeploySchema.array().parse(deploys);
  const totalDeploys = validated.length;

  if (totalDeploys === 0) {
    return {
      totalDeploys: 0,
      avgPnlPct: 0,
      winRatePct: 0,
      lastOutcome: null,
      lastDeployedAt: null,
    };
  }

  const avgPnlPct =
    validated.reduce((sum, deploy) => sum + deploy.pnlPct, 0) / totalDeploys;
  const wins = validated.filter((deploy) => deploy.pnlPct >= 0).length;
  const lastDeploy = validated[validated.length - 1] ?? null;

  return {
    totalDeploys,
    avgPnlPct: Number(avgPnlPct.toFixed(2)),
    winRatePct: Number(((wins / totalDeploys) * 100).toFixed(2)),
    lastOutcome:
      lastDeploy === null ? null : lastDeploy.pnlPct >= 0 ? "profit" : "loss",
    lastDeployedAt: lastDeploy?.deployedAt ?? null,
  };
}

export function shouldCooldown(input: {
  closeReason: CloseReason;
  closeReasonSet?: CloseReason[];
}): boolean {
  const closeReasonSet = input.closeReasonSet ?? ["volume_collapse"];
  return closeReasonSet.includes(input.closeReason);
}

export function buildPoolRecallString(
  entry: PoolMemoryEntry,
  options?: { now?: string },
): string | null {
  const validated = PoolMemoryEntrySchema.parse(entry);
  const now = options?.now ?? new Date().toISOString();
  if (
    validated.totalDeploys === 0 &&
    validated.notes.length === 0 &&
    validated.snapshots.length === 0 &&
    validated.cooldownUntil === undefined
  ) {
    return null;
  }

  const lines: string[] = [];
  if (validated.totalDeploys > 0) {
    lines.push(
      `POOL MEMORY [${validated.name}]: ${validated.totalDeploys} deploy(s), avg PnL ${validated.avgPnlPct.toFixed(2)}%, win rate ${validated.winRatePct.toFixed(2)}%, last outcome: ${validated.lastOutcome ?? "unknown"}`,
    );

    const lastDeploy = validated.deploys[validated.deploys.length - 1];
    if (lastDeploy !== undefined) {
      lines.push(
        `Last deploy: pnl ${lastDeploy.pnlPct.toFixed(2)}% ($${lastDeploy.pnlUsd.toFixed(2)}), closeReason ${lastDeploy.closeReason}, strategy ${lastDeploy.strategy}, held ${lastDeploy.minutesHeld}m, range efficiency ${lastDeploy.rangeEfficiencyPct.toFixed(2)}%`,
      );
    }
  }

  const recentSnapshots = validated.snapshots.slice(-6);
  if (recentSnapshots.length >= 2) {
    const first = recentSnapshots[0];
    const last = recentSnapshots[recentSnapshots.length - 1];
    if (first !== undefined && last !== undefined) {
      lines.push(
        `Recent trend: PnL ${first.pnlPct.toFixed(2)}% -> ${last.pnlPct.toFixed(2)}%, OOR minutes ${last.minutesOutOfRange}, unclaimed fees $${last.unclaimedFeesUsd.toFixed(2)}`,
      );
    }
  }

  if (validated.cooldownUntil !== undefined) {
    const cooldownMs = Date.parse(validated.cooldownUntil);
    const nowMs = Date.parse(now);
    if (
      !Number.isNaN(cooldownMs) &&
      !Number.isNaN(nowMs) &&
      cooldownMs > nowMs
    ) {
      lines.push(`Cooldown until: ${validated.cooldownUntil}`);
    }
  }

  const recentNotes = validated.notes.slice(-3);
  if (recentNotes.length === 1) {
    const [lastNote] = recentNotes;
    if (lastNote !== undefined) {
      lines.push(`Last note [${lastNote.addedAt}]: ${lastNote.note}`);
    }
  } else if (recentNotes.length > 1) {
    lines.push(
      [
        "Recent notes:",
        ...recentNotes.map((note) => `- [${note.addedAt}] ${note.note}`),
      ].join("\n"),
    );
  }

  return lines.length === 0 ? null : lines.join("\n");
}

export function applyCooldownFilter<T extends { poolAddress: string }>(input: {
  candidates: T[];
  poolMemoryMap: Record<string, Pick<PoolMemoryEntry, "cooldownUntil">>;
  now: string;
}): T[] {
  const nowMs = Date.parse(input.now);

  return input.candidates.filter((candidate) => {
    const cooldownUntil =
      input.poolMemoryMap[candidate.poolAddress]?.cooldownUntil;
    if (cooldownUntil === undefined) {
      return true;
    }

    const cooldownMs = Date.parse(cooldownUntil);
    if (Number.isNaN(nowMs) || Number.isNaN(cooldownMs)) {
      return true;
    }

    return cooldownMs <= nowMs;
  });
}
