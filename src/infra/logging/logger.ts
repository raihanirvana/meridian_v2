import pino from "pino";

const REDACTED = "[REDACTED]";
const SECRET_KEY_NAMES = new Set([
  "walletprivatekey",
  "rpcurl",
  "screeningapikey",
  "analyticsapikey",
  "jupiterapikey",
  "llmapikey",
  "llmbaseurl",
  "telegrambottoken",
  "authorization",
  "x-api-key",
  "apikey",
  "token",
  "secret",
]);

export const DEFAULT_LOG_REDACT_PATHS = [
  "secrets.WALLET_PRIVATE_KEY",
  "secrets.RPC_URL",
  "secrets.SCREENING_API_KEY",
  "secrets.ANALYTICS_API_KEY",
  "secrets.JUPITER_API_KEY",
  "secrets.LLM_API_KEY",
  "secrets.LLM_BASE_URL",
  "secrets.TELEGRAM_BOT_TOKEN",
  "headers.authorization",
  "headers.Authorization",
  "headers.x-api-key",
  "headers.X-API-Key",
  "authorization",
  "token",
  "apiKey",
  "secret",
  "walletPrivateKey",
  "rpcUrl",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function redactLogData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactLogData(item));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => {
      const normalizedKey = key.toLowerCase().replaceAll(/[_-]/g, "");
      if (
        SECRET_KEY_NAMES.has(key.toLowerCase()) ||
        SECRET_KEY_NAMES.has(normalizedKey)
      ) {
        return [key, REDACTED];
      }

      return [key, redactLogData(nestedValue)];
    }),
  );
}

export function createLogger(level = process.env.LOG_LEVEL ?? "info") {
  return pino({
    name: "meridian-v2",
    level,
    redact: {
      paths: [...DEFAULT_LOG_REDACT_PATHS],
      censor: REDACTED,
    },
  });
}

export const logger = createLogger();
