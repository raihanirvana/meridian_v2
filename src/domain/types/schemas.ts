import { z } from "zod";

export const ActorSchema = z.enum(["system", "operator", "ai"]);

export const ExampleActionEnvelopeSchema = z.object({
  actionId: z.string().min(1),
  type: z.enum(["DEPLOY", "CLOSE", "RECONCILE"]),
  requestedBy: ActorSchema,
  requestedAt: z.string().datetime(),
});

export type Actor = z.infer<typeof ActorSchema>;
export type ExampleActionEnvelope = z.infer<typeof ExampleActionEnvelopeSchema>;
