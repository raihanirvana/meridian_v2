import { describe, expect, it } from "vitest";

import { redactLogData } from "../../src/infra/logging/logger.js";

describe("logger redaction", () => {
  it("redacts nested secret-like keys before logging", () => {
    const redacted = redactLogData({
      headers: {
        authorization: "Bearer secret-token",
      },
      secrets: {
        WALLET_PRIVATE_KEY: "top-secret",
      },
      nested: {
        apiKey: "screening-secret",
        safe: "ok",
      },
    }) as Record<string, unknown>;

    expect(JSON.stringify(redacted)).not.toContain("secret-token");
    expect(JSON.stringify(redacted)).not.toContain("top-secret");
    expect(JSON.stringify(redacted)).not.toContain("screening-secret");
    expect(JSON.stringify(redacted)).toContain("[REDACTED]");
    expect(JSON.stringify(redacted)).toContain('"safe":"ok"');
  });
});
