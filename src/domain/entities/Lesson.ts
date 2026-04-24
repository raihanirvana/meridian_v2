import { z } from "zod";

import { LessonOutcomeSchema, LessonRoleSchema } from "../types/enums.js";
import { UlidSchema } from "../types/schemas.js";

const TimestampSchema = z.string().datetime();

export const LessonSchema = z
  .object({
    id: UlidSchema,
    rule: z.string().min(1).max(500),
    tags: z.array(z.string().min(1)).default([]),
    outcome: LessonOutcomeSchema,
    role: LessonRoleSchema.nullable().default(null),
    pinned: z.boolean().default(false),
    pnlPct: z.number().optional(),
    rangeEfficiencyPct: z.number().min(0).max(100).optional(),
    pool: z.string().min(1).optional(),
    context: z.string().min(1).optional(),
    createdAt: TimestampSchema,
  })
  .strict()
  .transform((lesson) => ({
    ...lesson,
    tags: [
      ...new Set(
        lesson.tags
          .map((tag) => tag.toLowerCase().trim())
          .filter((tag) => tag.length > 0),
      ),
    ],
  }));

export type Lesson = z.infer<typeof LessonSchema>;
