import { z } from "zod";

import { ActorSchema } from "../types/enums.js";

const TimestampSchema = z.string().datetime();

export const JournalEventSchema = z
  .object({
    timestamp: TimestampSchema,
    eventType: z.string().min(1),
    actor: ActorSchema,
    wallet: z.string().min(1),
    positionId: z.string().min(1).nullable(),
    actionId: z.string().min(1).nullable(),
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()).nullable(),
    txIds: z.array(z.string().min(1)),
    resultStatus: z.string().min(1),
    error: z.string().min(1).nullable(),
  })
  .strict();

export type JournalEvent = z.infer<typeof JournalEventSchema>;
