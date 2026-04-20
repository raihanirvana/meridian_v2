import { z } from "zod";

export const TimestampSchema = z.string().datetime();
export const JsonRecordSchema = z.record(z.string(), z.unknown());
