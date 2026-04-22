import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MeridianPaths {
  dataDir: string;
  positionsFilePath: string;
  actionsFilePath: string;
  journalFilePath: string;
  lessonsFilePath: string;
  policyOverridesFilePath: string;
  poolMemoryFilePath: string;
  signalWeightsFilePath: string;
  schedulerMetadataFilePath: string;
  runtimeControlsFilePath: string;
}

export function resolveMeridianPaths(dataDir?: string): MeridianPaths {
  const resolvedDataDir =
    dataDir ??
    process.env.MERIDIAN_DATA_DIR ??
    path.join(os.homedir(), ".meridian-v2");

  return {
    dataDir: resolvedDataDir,
    positionsFilePath: path.join(resolvedDataDir, "positions.json"),
    actionsFilePath: path.join(resolvedDataDir, "actions.json"),
    journalFilePath: path.join(resolvedDataDir, "journal.jsonl"),
    lessonsFilePath: path.join(resolvedDataDir, "lessons.json"),
    policyOverridesFilePath: path.join(resolvedDataDir, "policy-overrides.json"),
    poolMemoryFilePath: path.join(resolvedDataDir, "pool-memory.json"),
    signalWeightsFilePath: path.join(resolvedDataDir, "signal-weights.json"),
    schedulerMetadataFilePath: path.join(resolvedDataDir, "scheduler-metadata.json"),
    runtimeControlsFilePath: path.join(resolvedDataDir, "runtime-controls.json"),
  };
}

export function ensureDataDir(dataDir?: string): MeridianPaths {
  const paths = resolveMeridianPaths(dataDir);
  fs.mkdirSync(paths.dataDir, { recursive: true });
  return paths;
}
