import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MeridianPaths {
  dataDir: string;
  lessonsFilePath: string;
  policyOverridesFilePath: string;
  poolMemoryFilePath: string;
  signalWeightsFilePath: string;
}

export function resolveMeridianPaths(dataDir?: string): MeridianPaths {
  const resolvedDataDir =
    dataDir ??
    process.env.MERIDIAN_DATA_DIR ??
    path.join(os.homedir(), ".meridian-v2");

  return {
    dataDir: resolvedDataDir,
    lessonsFilePath: path.join(resolvedDataDir, "lessons.json"),
    policyOverridesFilePath: path.join(resolvedDataDir, "policy-overrides.json"),
    poolMemoryFilePath: path.join(resolvedDataDir, "pool-memory.json"),
    signalWeightsFilePath: path.join(resolvedDataDir, "signal-weights.json"),
  };
}

export function ensureDataDir(dataDir?: string): MeridianPaths {
  const paths = resolveMeridianPaths(dataDir);
  fs.mkdirSync(paths.dataDir, { recursive: true });
  return paths;
}
