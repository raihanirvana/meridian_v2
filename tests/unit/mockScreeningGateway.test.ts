import { describe, expect, it } from "vitest";

import { MockScreeningGateway } from "../../src/adapters/screening/ScreeningGateway.js";

describe("MockScreeningGateway", () => {
  it("rejects invalid candidate payloads returned by listCandidates", async () => {
    const invalidCandidates: unknown = [
      {
        candidateId: "cand_invalid",
        poolAddress: "pool_invalid",
      },
    ];

    const gateway = new MockScreeningGateway({
      listCandidates: {
        type: "success",
        value: invalidCandidates as never,
      },
      getCandidateDetails: {
        type: "success",
        value: {
          poolAddress: "pool_invalid",
          pairLabel: "SOL-USDC",
          feeToTvlRatio: 0.1,
          organicScore: 80,
          holderCount: 1_000,
        },
      },
    });

    await expect(
      gateway.listCandidates({
        limit: 1,
        timeframe: "5m",
      }),
    ).rejects.toThrow();
  });
});
