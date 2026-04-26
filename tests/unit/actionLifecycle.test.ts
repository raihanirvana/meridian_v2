import { describe, expect, it } from "vitest";

import {
  canTransitionActionStatus,
  transitionActionStatus,
} from "../../src/domain/stateMachines/actionLifecycle.js";
import { ActionSchema, type Action } from "../../src/domain/entities/Action.js";

describe("actionLifecycle", () => {
  it("supports the happy path from QUEUED to DONE", () => {
    let status: Action["status"] = "QUEUED";

    status = transitionActionStatus(status, "RUNNING");
    status = transitionActionStatus(status, "WAITING_CONFIRMATION");
    status = transitionActionStatus(status, "RECONCILING");
    status = transitionActionStatus(status, "DONE");

    expect(status).toBe("DONE");
  });

  it("supports retry after failure", () => {
    let status: Action["status"] = "RUNNING";

    status = transitionActionStatus(status, "FAILED");
    status = transitionActionStatus(status, "RETRY_QUEUED");
    status = transitionActionStatus(status, "RUNNING");

    expect(status).toBe("RUNNING");
  });

  it("rejects invalid transition from QUEUED to DONE", () => {
    expect(canTransitionActionStatus("QUEUED", "DONE")).toBe(false);
    expect(() => transitionActionStatus("QUEUED", "DONE")).toThrow(
      /Invalid action transition/i,
    );
  });

  it("rejects direct retry after timeout", () => {
    expect(canTransitionActionStatus("TIMED_OUT", "RETRY_QUEUED")).toBe(false);
  });

  it("parses an action entity with official lifecycle status", () => {
    const result = ActionSchema.safeParse({
      actionId: "act_001",
      type: "DEPLOY",
      status: "QUEUED",
      wallet: "wallet_001",
      positionId: null,
      idempotencyKey: "wallet_001:deploy:001",
      requestPayload: {
        poolAddress: "pool_001",
      },
      resultPayload: null,
      txIds: [],
      error: null,
      requestedAt: "2026-04-18T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      requestedBy: "system",
    });

    expect(result.success).toBe(true);
  });

  it("rejects DONE actions without completedAt", () => {
    const result = ActionSchema.safeParse({
      actionId: "act_002",
      type: "DEPLOY",
      status: "DONE",
      wallet: "wallet_001",
      positionId: null,
      idempotencyKey: "wallet_001:deploy:002",
      requestPayload: {
        poolAddress: "pool_001",
      },
      resultPayload: {
        positionId: "pos_001",
      },
      txIds: ["tx_001"],
      error: null,
      requestedAt: "2026-04-18T00:00:00.000Z",
      startedAt: "2026-04-18T00:01:00.000Z",
      completedAt: null,
      requestedBy: "system",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a DEPLOY action that incorrectly carries positionId", () => {
    const result = ActionSchema.safeParse({
      actionId: "act_003",
      type: "DEPLOY",
      status: "QUEUED",
      wallet: "wallet_001",
      positionId: "pos_should_not_exist",
      idempotencyKey: "wallet_001:deploy:003",
      requestPayload: {
        poolAddress: "pool_001",
      },
      resultPayload: null,
      txIds: [],
      error: null,
      requestedAt: "2026-04-18T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      requestedBy: "system",
    });

    expect(result.success).toBe(false);
  });

  it("requires positionId for CLOSE actions", () => {
    const result = ActionSchema.safeParse({
      actionId: "act_004",
      type: "CLOSE",
      status: "QUEUED",
      wallet: "wallet_001",
      positionId: null,
      idempotencyKey: "wallet_001:close:004",
      requestPayload: {
        reason: "stop loss",
      },
      resultPayload: null,
      txIds: [],
      error: null,
      requestedAt: "2026-04-18T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      requestedBy: "system",
    });

    expect(result.success).toBe(false);
  });
});
