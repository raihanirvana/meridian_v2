import fs from "node:fs";

import {
  EnvSecretsSchema,
  type EnvSecrets,
  ResolvedConfigSchema,
  type ResolvedConfig,
  type UserConfig,
  UserConfigSchema,
} from "./configSchema.js";

const SECRET_BOUNDARY_KEYS = new Set([
  "walletPrivateKey",
  "rpcUrl",
  "screeningApiKey",
  "analyticsApiKey",
  "jupiterApiKey",
  "llmApiKey",
  "llmBaseUrl",
  "telegramBotToken",
]);

export class ConfigValidationError extends Error {
  public readonly details: string[];

  public constructor(message: string, details: string[] = []) {
    super(details.length > 0 ? `${message}: ${details.join("; ")}` : message);
    this.name = "ConfigValidationError";
    this.details = details;
  }
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  envFilePath?: string;
  userConfigPath: string;
}

function parseDotEnv(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

function buildSecretInput(
  envFileValues: Record<string, string>,
  runtimeEnv: NodeJS.ProcessEnv,
): Partial<EnvSecrets> {
  const input: Partial<EnvSecrets> = {};

  const walletPrivateKey =
    runtimeEnv.WALLET_PRIVATE_KEY ?? envFileValues.WALLET_PRIVATE_KEY;
  if (walletPrivateKey !== undefined) {
    input.WALLET_PRIVATE_KEY = walletPrivateKey;
  }

  const rpcUrl = runtimeEnv.RPC_URL ?? envFileValues.RPC_URL;
  if (rpcUrl !== undefined) {
    input.RPC_URL = rpcUrl;
  }

  const screeningApiKey =
    runtimeEnv.SCREENING_API_KEY ?? envFileValues.SCREENING_API_KEY;
  if (screeningApiKey !== undefined) {
    input.SCREENING_API_KEY = screeningApiKey;
  }

  const analyticsApiKey =
    runtimeEnv.ANALYTICS_API_KEY ?? envFileValues.ANALYTICS_API_KEY;
  if (analyticsApiKey !== undefined) {
    input.ANALYTICS_API_KEY = analyticsApiKey;
  }

  const jupiterApiKey =
    runtimeEnv.JUPITER_API_KEY ?? envFileValues.JUPITER_API_KEY;
  if (jupiterApiKey !== undefined) {
    input.JUPITER_API_KEY = jupiterApiKey;
  }

  const llmApiKey = runtimeEnv.LLM_API_KEY ?? envFileValues.LLM_API_KEY;
  if (llmApiKey !== undefined) {
    input.LLM_API_KEY = llmApiKey;
  }

  const llmBaseUrl = runtimeEnv.LLM_BASE_URL ?? envFileValues.LLM_BASE_URL;
  if (llmBaseUrl !== undefined) {
    input.LLM_BASE_URL = llmBaseUrl;
  }

  const telegramBotToken =
    runtimeEnv.TELEGRAM_BOT_TOKEN ?? envFileValues.TELEGRAM_BOT_TOKEN;
  if (telegramBotToken !== undefined) {
    input.TELEGRAM_BOT_TOKEN = telegramBotToken;
  }

  return input;
}

function formatZodIssues(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string[] {
  return error.issues.flatMap((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";

    if (issue.message.startsWith("Unrecognized key:")) {
      const matches = [...issue.message.matchAll(/"([^"]+)"/g)];
      if (matches.length > 0) {
        return matches.map((match) => `${path}.${match[1]}: unrecognized key`);
      }
    }

    return [`${path}: ${issue.message}`];
  });
}

function readUserConfig(userConfigPath: string): unknown {
  const rawContents = fs.readFileSync(userConfigPath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(rawContents);
}

function assertNoSecretsInUserConfig(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return;
  }

  for (const key of Object.keys(input)) {
    if (SECRET_BOUNDARY_KEYS.has(key)) {
      throw new ConfigValidationError(
        `Secret key "${key}" is not allowed in user-config.json`,
        [`${key}: move this value into .env`],
      );
    }
  }
}

export function redactSecretsForLogging(config: ResolvedConfig): Record<string, unknown> {
  return {
    secrets: {
      WALLET_PRIVATE_KEY: "[REDACTED]",
      RPC_URL: "[REDACTED]",
      SCREENING_API_KEY: config.secrets.SCREENING_API_KEY
        ? "[REDACTED]"
        : undefined,
      ANALYTICS_API_KEY: config.secrets.ANALYTICS_API_KEY
        ? "[REDACTED]"
        : undefined,
      JUPITER_API_KEY: config.secrets.JUPITER_API_KEY ? "[REDACTED]" : undefined,
      LLM_API_KEY: config.secrets.LLM_API_KEY ? "[REDACTED]" : undefined,
      LLM_BASE_URL: config.secrets.LLM_BASE_URL ? "[REDACTED]" : undefined,
      TELEGRAM_BOT_TOKEN: config.secrets.TELEGRAM_BOT_TOKEN
        ? "[REDACTED]"
        : undefined,
    },
    user: config.user,
  };
}

export function loadConfig(options: LoadConfigOptions): ResolvedConfig {
  const runtimeEnv = options.env ?? process.env;
  const envFileValues =
    options.envFilePath && fs.existsSync(options.envFilePath)
      ? parseDotEnv(fs.readFileSync(options.envFilePath, "utf8"))
      : {};

  const parsedSecrets = EnvSecretsSchema.safeParse(
    buildSecretInput(envFileValues, runtimeEnv),
  );
  if (!parsedSecrets.success) {
    throw new ConfigValidationError(
      "Invalid .env configuration",
      formatZodIssues(parsedSecrets.error),
    );
  }

  if (!fs.existsSync(options.userConfigPath)) {
    throw new ConfigValidationError("user-config.json is required", [
      `${options.userConfigPath}: file not found`,
    ]);
  }

  let rawUserConfig: unknown;
  try {
    rawUserConfig = readUserConfig(options.userConfigPath);
  } catch (error) {
    throw new ConfigValidationError("Failed to parse user-config.json", [
      error instanceof Error ? error.message : "unknown parse error",
    ]);
  }

  assertNoSecretsInUserConfig(rawUserConfig);

  const parsedUserConfig = UserConfigSchema.safeParse(rawUserConfig);
  if (!parsedUserConfig.success) {
    throw new ConfigValidationError(
      "Invalid user-config.json configuration",
      formatZodIssues(parsedUserConfig.error),
    );
  }

  const resolved = {
    secrets: parsedSecrets.data,
    user: parsedUserConfig.data,
  } satisfies {
    secrets: EnvSecrets;
    user: UserConfig;
  };

  return ResolvedConfigSchema.parse(resolved);
}
