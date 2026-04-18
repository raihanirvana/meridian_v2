import { describe, expect, it } from "vitest";

import { ExampleActionEnvelopeSchema } from "../../src/domain/types/schemas.js";

describe("ExampleActionEnvelopeSchema", () => {
  it("accepts a valid action envelope", () => {
    const result = ExampleActionEnvelopeSchema.safeParse({
      actionId: "act_001",
      type: "DEPLOY",
      requestedBy: "system",
      requestedAt: "2026-04-18T00:00:00.000Z",
    });

    expect(result.success).toBe(true);
  });
});
