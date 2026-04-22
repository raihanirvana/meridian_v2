import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigValidationError,
  loadConfig,
  redactSecretsForLogging,
} from "../../src/infra/config/loadConfig.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-v2-config-"));
  tempDirs.push(directory);
  return directory;
}

function writeFixtureFiles(directory: string, overrides?: { userConfig?: string; env?: string }) {
  const envPath = path.join(directory, ".env");
  const userConfigPath = path.join(directory, "user-config.json");

  fs.writeFileSync(
    envPath,
    overrides?.env ??
      [
        "WALLET_PRIVATE_KEY=test_private_key",
        "RPC_URL=https://rpc.example.com",
        "LLM_API_KEY=llm_secret",
        "TELEGRAM_BOT_TOKEN=telegram_secret",
      ].join("\n"),
  );

  fs.writeFileSync(
    userConfigPath,
    overrides?.userConfig ??
      JSON.stringify(
        {
          risk: {
            maxConcurrentPositions: 3,
            maxCapitalUsagePct: 70,
            minReserveUsd: 0.5,
            maxTokenExposurePct: 35,
            maxPoolExposurePct: 40,
            maxRebalancesPerPosition: 2,
            dailyLossLimitPct: 8,
            circuitBreakerCooldownMin: 180,
            maxNewDeploysPerHour: 2,
          },
          screening: {
            minMarketCapUsd: 150000,
            maxMarketCapUsd: 10000000,
            minTvlUsd: 10000,
            minVolumeUsd: 500,
            minFeeActiveTvlRatio: 0.05,
            minOrganic: 60,
            minHolderCount: 500,
            allowedBinSteps: [80, 100, 125],
            blockedLaunchpads: [],
          },
          schedule: {
            screeningIntervalSec: 1800,
            managementIntervalSec: 600,
            reconciliationIntervalSec: 300,
            reportingIntervalSec: 3600,
          },
          management: {
            stopLossUsd: 50,
            maxHoldMinutes: 1440,
            maxOutOfRangeMinutes: 240,
            claimFeesThresholdUsd: 20,
            partialCloseEnabled: false,
            partialCloseProfitTargetUsd: 100,
            rebalanceEnabled: true,
          },
          ai: {
            mode: "advisory",
          },
          deploy: {
            defaultAmountSol: 0.5,
            minAmountSol: 0.2,
          },
          notifications: {
            telegramEnabled: false,
          },
          poolMemory: {
            snapshotsEnabled: false,
          },
          darwin: {
            enabled: false,
          },
          runtime: {
            dryRun: true,
            logLevel: "info",
          },
        },
        null,
        2,
      ),
  );

  return { envPath, userConfigPath };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  it("loads secrets from .env and non-secret config from user-config.json", () => {
    const directory = makeTempDir();
    const { envPath, userConfigPath } = writeFixtureFiles(directory);

    const config = loadConfig({
      env: {},
      envFilePath: envPath,
      userConfigPath,
    });

    expect(config.secrets.WALLET_PRIVATE_KEY).toBe("test_private_key");
    expect(config.secrets.RPC_URL).toBe("https://rpc.example.com");
    expect(config.user.runtime.dryRun).toBe(true);
    expect(config.user.ai.mode).toBe("advisory");
    expect(config.user.deploy.defaultAmountSol).toBe(0.5);
  });

  it("rejects secret keys inside user-config.json", () => {
    const directory = makeTempDir();
    const { envPath, userConfigPath } = writeFixtureFiles(directory, {
      userConfig: JSON.stringify({
        rpcUrl: "https://should-not-be-here.example.com",
      }),
    });

    expect(() =>
      loadConfig({
        env: {},
        envFilePath: envPath,
        userConfigPath,
      }),
    ).toThrowError(ConfigValidationError);

    expect(() =>
      loadConfig({
        env: {},
        envFilePath: envPath,
        userConfigPath,
      }),
    ).toThrow(/move this value into \.env/i);
  });

  it("rejects invalid user config values and unknown keys", () => {
    const directory = makeTempDir();
    const { envPath, userConfigPath } = writeFixtureFiles(directory, {
      userConfig: JSON.stringify({
        risk: {
          maxConcurrentPositions: 3,
          maxCapitalUsagePct: 70,
          minReserveUsd: -1,
          maxTokenExposurePct: 35,
          maxPoolExposurePct: 40,
          maxRebalancesPerPosition: 2,
          dailyLossLimitPct: 8,
          circuitBreakerCooldownMin: 180,
          maxNewDeploysPerHour: 2,
        },
        screening: {
          minMarketCapUsd: 150000,
          maxMarketCapUsd: 10000000,
          minTvlUsd: 10000,
          minVolumeUsd: 500,
          minFeeActiveTvlRatio: 0.05,
          minOrganic: 60,
          minHolderCount: 500,
          allowedBinSteps: [80, 100, 125],
          blockedLaunchpads: [],
          unexpectedKey: true,
        },
        schedule: {
          screeningIntervalSec: 1800,
          managementIntervalSec: 600,
          reconciliationIntervalSec: 300,
          reportingIntervalSec: 3600,
        },
        management: {
          stopLossUsd: 50,
          maxHoldMinutes: 1440,
          maxOutOfRangeMinutes: 240,
          claimFeesThresholdUsd: 20,
          partialCloseEnabled: false,
          partialCloseProfitTargetUsd: 100,
          rebalanceEnabled: true,
        },
        ai: {
          mode: "advisory",
        },
        deploy: {
          defaultAmountSol: 0.5,
          minAmountSol: 0.2,
        },
        notifications: {
          telegramEnabled: false,
        },
        poolMemory: {
          snapshotsEnabled: false,
        },
        darwin: {
          enabled: false,
        },
        runtime: {
          dryRun: true,
          logLevel: "info",
        },
      }),
    });

    try {
      loadConfig({
        env: {},
        envFilePath: envPath,
        userConfigPath,
      });
      throw new Error("Expected ConfigValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
        expect((error as ConfigValidationError).details).toEqual(
          expect.arrayContaining([
          expect.stringMatching(/risk\.minReserveUsd/i),
          expect.stringMatching(/screening\.unexpectedKey/i),
        ]),
      );
    }
  });

  it("redacts secrets for logging", () => {
    const directory = makeTempDir();
    const { envPath, userConfigPath } = writeFixtureFiles(directory);
    const config = loadConfig({
      env: {},
      envFilePath: envPath,
      userConfigPath,
    });

    const redacted = redactSecretsForLogging(config);
    const redactedText = JSON.stringify(redacted);

    expect(redactedText).not.toContain("test_private_key");
    expect(redactedText).not.toContain("llm_secret");
    expect(redactedText).not.toContain("telegram_secret");
    expect(redactedText).toContain("[REDACTED]");
    expect(redactedText).toContain("\"dryRun\":true");
  });
});
