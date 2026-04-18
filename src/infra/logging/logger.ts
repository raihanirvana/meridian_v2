import pino from "pino";

export const logger = pino({
  name: "meridian-v2",
  level: process.env.LOG_LEVEL ?? "info",
});
