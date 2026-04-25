import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run") || !apply;
  const dataDirFlag = argv.find((arg) => arg.startsWith("--data-dir="));
  return {
    apply,
    dryRun,
    dataDir:
      dataDirFlag === undefined
        ? path.join(process.cwd(), "data")
        : dataDirFlag.slice("--data-dir=".length),
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function minutesBetween(start, end) {
  const startMs = Date.parse(start ?? "");
  const endMs = Date.parse(end ?? "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return 0;
  }
  return Math.max(0, Math.floor((endMs - startMs) / 60_000));
}

function classifyLesson(record, now) {
  if (record.pnlPct >= 5) {
    return {
      id: `backfill_good_${record.positionId}`,
      rule: `WORKED: ${record.poolName} strategy=${record.strategy} produced ${record.pnlPct.toFixed(2)}% PnL.`,
      tags: ["backfill", "worked", record.strategy],
      outcome: "good",
      role: null,
      pinned: false,
      pnlPct: record.pnlPct,
      rangeEfficiencyPct: record.rangeEfficiencyPct,
      pool: record.pool,
      context: `backfilled performance for ${record.positionId}`,
      createdAt: now,
    };
  }
  if (record.pnlPct < 0) {
    return {
      id: `backfill_bad_${record.positionId}`,
      rule: `FAILED: ${record.poolName} strategy=${record.strategy} closed at ${record.pnlPct.toFixed(2)}% PnL.`,
      tags: ["backfill", "failed", record.strategy],
      outcome: record.pnlPct <= -5 ? "bad" : "poor",
      role: null,
      pinned: false,
      pnlPct: record.pnlPct,
      rangeEfficiencyPct: record.rangeEfficiencyPct,
      pool: record.pool,
      context: `backfilled performance for ${record.positionId}`,
      createdAt: now,
    };
  }
  return null;
}

function buildRecord(position, action, now) {
  if (position.status !== "CLOSED" || position.closedAt === null) {
    return {
      skipped: true,
      reason: "not_closed",
      positionId: position.positionId,
    };
  }
  const finalValueUsd = Math.max(
    Number(position.currentValueUsd ?? 0) +
      Number(position.realizedPnlUsd ?? 0) +
      Number(position.feesClaimedUsd ?? 0),
    0,
  );
  const initialValueUsd = finalValueUsd - Number(position.realizedPnlUsd ?? 0);
  if (initialValueUsd <= 0) {
    return {
      skipped: true,
      reason: "invalid_cost_basis",
      positionId: position.positionId,
    };
  }
  const minutesHeld = minutesBetween(position.openedAt, position.closedAt);
  const minutesOutOfRange = minutesBetween(
    position.outOfRangeSince,
    position.closedAt,
  );
  const minutesInRange = Math.max(minutesHeld - minutesOutOfRange, 0);
  const rangeEfficiencyPct =
    minutesHeld === 0 ? 100 : Math.min((minutesInRange / minutesHeld) * 100, 100);
  const pnlUsd = Number(position.realizedPnlUsd ?? 0);
  const pnlPct = (pnlUsd / initialValueUsd) * 100;
  const metadata = position.entryMetadata ?? {};

  return {
    skipped: false,
    record: {
      positionId: position.positionId,
      wallet: position.wallet,
      pool: position.poolAddress,
      poolName: metadata.poolName ?? position.poolAddress,
      baseMint: position.baseMint,
      strategy: ["spot", "curve", "bid_ask"].includes(position.strategy)
        ? position.strategy
        : "bid_ask",
      binStep: metadata.binStep ?? 0,
      binRangeLower: position.rangeLowerBin,
      binRangeUpper: position.rangeUpperBin,
      volatility: metadata.volatility ?? 0,
      feeTvlRatio: metadata.feeTvlRatio ?? 0,
      organicScore: metadata.organicScore ?? 0,
      amountSol: metadata.amountSol ?? 0,
      initialValueUsd,
      finalValueUsd,
      feesEarnedUsd: Number(position.feesClaimedUsd ?? 0),
      pnlUsd,
      pnlPct,
      rangeEfficiencyPct,
      minutesHeld,
      minutesInRange,
      closeReason:
        action?.type === "REBALANCE"
          ? "out_of_range"
          : action?.requestedBy === "operator"
            ? "operator"
            : "manual",
      deployedAt: position.openedAt ?? now,
      closedAt: position.closedAt,
      recordedAt: now,
    },
  };
}

function updatePoolMemory(current, record) {
  const existing = current[record.pool] ?? {
    poolAddress: record.pool,
    name: record.poolName,
    baseMint: record.baseMint,
    totalDeploys: 0,
    deploys: [],
    avgPnlPct: 0,
    winRatePct: 0,
    lastDeployedAt: null,
    lastOutcome: null,
    notes: [],
    snapshots: [],
  };
  const deploys = [
    ...existing.deploys,
    {
      deployedAt: record.deployedAt,
      closedAt: record.closedAt,
      pnlPct: record.pnlPct,
      pnlUsd: record.pnlUsd,
      rangeEfficiencyPct: record.rangeEfficiencyPct,
      minutesHeld: record.minutesHeld,
      closeReason: record.closeReason,
      strategy: record.strategy,
      volatilityAtDeploy: record.volatility,
    },
  ].slice(-50);
  const wins = deploys.filter((deploy) => deploy.pnlPct > 0).length;
  const avgPnlPct =
    deploys.reduce((sum, deploy) => sum + deploy.pnlPct, 0) / deploys.length;
  return {
    ...current,
    [record.pool]: {
      ...existing,
      totalDeploys: deploys.length,
      deploys,
      avgPnlPct,
      winRatePct: (wins / deploys.length) * 100,
      lastDeployedAt: record.deployedAt,
      lastOutcome: record.pnlPct >= 0 ? "profit" : "loss",
    },
  };
}

const args = parseArgs(process.argv.slice(2));
const now = new Date().toISOString();
const positionsPath = path.join(args.dataDir, "positions.json");
const actionsPath = path.join(args.dataDir, "actions.json");
const lessonsPath = path.join(args.dataDir, "lessons.json");
const poolMemoryPath = path.join(args.dataDir, "pool-memory.json");

const positions = asArray(await readJson(positionsPath, []));
const actions = asArray(await readJson(actionsPath, []));
const lessonStore = await readJson(lessonsPath, {
  lessons: [],
  performance: [],
});
const poolMemory = await readJson(poolMemoryPath, {});
const existingPerformanceIds = new Set(
  asArray(lessonStore.performance).map((record) => record.positionId),
);
const existingLessonIds = new Set(
  asArray(lessonStore.lessons).map((lesson) => lesson.id),
);
const actionByPosition = new Map(
  actions
    .filter((action) => action.positionId !== null)
    .map((action) => [action.positionId, action]),
);

const records = [];
const lessons = [];
const warnings = [];
let nextPoolMemory = poolMemory;

for (const position of positions) {
  if (existingPerformanceIds.has(position.positionId)) {
    continue;
  }
  const built = buildRecord(
    position,
    actionByPosition.get(position.positionId),
    now,
  );
  if (built.skipped) {
    warnings.push({
      positionId: built.positionId,
      reason: built.reason,
    });
    continue;
  }
  records.push(built.record);
  const lesson = classifyLesson(built.record, now);
  if (lesson !== null && !existingLessonIds.has(lesson.id)) {
    lessons.push(lesson);
  }
  nextPoolMemory = updatePoolMemory(nextPoolMemory, built.record);
}

const summary = {
  mode: args.apply ? "apply" : "dry-run",
  dataDir: args.dataDir,
  recordsToCreate: records.length,
  lessonsToCreate: lessons.length,
  poolMemoryPoolsTouched: new Set(records.map((record) => record.pool)).size,
  warnings,
};

if (args.dryRun) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(0);
}

await writeFile(
  lessonsPath,
  JSON.stringify(
    {
      lessons: [...asArray(lessonStore.lessons), ...lessons],
      performance: [...asArray(lessonStore.performance), ...records],
    },
    null,
    2,
  ),
);
await writeFile(poolMemoryPath, JSON.stringify(nextPoolMemory, null, 2));
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
