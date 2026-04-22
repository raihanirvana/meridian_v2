import { z } from "zod";

export const TimestampSchema = z.string().datetime();
export const JsonRecordSchema = z.record(z.string(), z.unknown());
export const UlidSchema = z
  .string()
  .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Invalid ULID");
