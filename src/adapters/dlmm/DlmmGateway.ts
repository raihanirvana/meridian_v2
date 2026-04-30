import { z } from "zod";

import {
  PositionSchema,
  type Position,
} from "../../domain/entities/Position.js";
import { StrategySchema } from "../../domain/types/enums.js";
import { type MockBehavior, resolveMockBehavior } from "../mockBehavior.js";

export type AmbiguousSubmissionOperation =
  | "DEPLOY"
  | "CLOSE"
  | "REBALANCE"
  | "PARTIAL_CLOSE"
  | "CLAIM_FEES";

export interface AmbiguousSubmissionDetails {
  operation: AmbiguousSubmissionOperation;
  positionId: string;
  txIds?: string[];
}

/**
 * Thrown by adapters when a transaction may have been broadcast on-chain but
 * the response was lost (network timeout after submit, malformed/partial
 * response, etc.). Callers MUST NOT mark the action FAILED — the position may
 * have changed on-chain and reconciliation is required.
 *
 * positionId is required: for Meteora DLMM, position addresses are PDA-derived
 * from instruction params and are always known to the adapter before submit.
 */
export class AmbiguousSubmissionError extends Error {
  public readonly operation: AmbiguousSubmissionOperation;
  public readonly positionId: string;
  public readonly txIds: string[];

  public constructor(
    message: string,
    details: AmbiguousSubmissionDetails,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AmbiguousSubmissionError";
    this.operation = details.operation;
    this.positionId = details.positionId;
    this.txIds = details.txIds ?? [];
  }
}

export function isAmbiguousSubmissionError(
  error: unknown,
): error is AmbiguousSubmissionError {
  return error instanceof AmbiguousSubmissionError;
}

export const DeployLiquidityRequestSchema = z
  .object({
    wallet: z.string().min(1),
    poolAddress: z.string().min(1),
    tokenXMint: z.string().min(1).optional(),
    tokenYMint: z.string().min(1).optional(),
    baseMint: z.string().min(1).optional(),
    quoteMint: z.string().min(1).optional(),
    amountBase: z.number().nonnegative(),
    amountQuote: z.number().nonnegative(),
    slippageBps: z.number().int().positive().max(10_000).optional(),
    strategy: StrategySchema,
    rangeLowerBin: z.number().int().optional(),
    rangeUpperBin: z.number().int().optional(),
    initialActiveBin: z.number().int().nullable().optional(),
  })
  .superRefine((payload, ctx) => {
    if (payload.amountBase <= 0 && payload.amountQuote <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountBase"],
        message: "amountBase or amountQuote must be greater than zero",
      });
    }

    if (
      payload.rangeLowerBin !== undefined &&
      payload.rangeUpperBin !== undefined &&
      payload.rangeLowerBin >= payload.rangeUpperBin
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rangeUpperBin"],
        message: "must be greater than rangeLowerBin",
      });
    }
  });

export const DeployLiquidityResultSchema = z.object({
  actionType: z.literal("DEPLOY"),
  positionId: z.string().min(1),
  txIds: z.array(z.string().min(1)),
  submissionStatus: z
    .enum(["not_submitted", "maybe_submitted", "submitted"])
    .default("submitted"),
  submissionAmbiguous: z.boolean().optional(),
});

export const ClosePositionRequestSchema = z.object({
  wallet: z.string().min(1),
  positionId: z.string().min(1),
  reason: z.string().min(1),
});

export const ClosePositionResultSchema = z.object({
  actionType: z.literal("CLOSE"),
  closedPositionId: z.string().min(1),
  txIds: z.array(z.string().min(1)),
  submissionStatus: z
    .enum(["not_submitted", "maybe_submitted", "submitted"])
    .default("submitted"),
  preCloseFeesClaimed: z.boolean().optional(),
  preCloseFeesClaimError: z.string().min(1).nullable().optional(),
  releasedAmountBase: z.number().nonnegative().optional(),
  releasedAmountBaseRaw: z.string().regex(/^\d+$/).optional(),
  releasedAmountQuote: z.number().nonnegative().optional(),
  releasedAmountQuoteRaw: z.string().regex(/^\d+$/).optional(),
  estimatedReleasedValueUsd: z.number().nonnegative().optional(),
  releasedAmountSource: z
    .enum(["post_tx", "position_snapshot", "unavailable"])
    .optional(),
  submissionAmbiguous: z.boolean().optional(),
});

export const ClaimFeesRequestSchema = z.object({
  wallet: z.string().min(1),
  positionId: z.string().min(1),
  baseMint: z.string().min(1).optional(),
});

export const ClaimFeesResultSchema = z.object({
  actionType: z.literal("CLAIM_FEES"),
  claimedBaseAmount: z.number().nonnegative(),
  claimedBaseAmountRaw: z.string().regex(/^\d+$/).optional(),
  claimedBaseAmountUsd: z.number().nonnegative().optional(),
  claimedBaseAmountSource: z
    .enum(["post_tx", "cache", "pnl_estimate", "unavailable"])
    .optional(),
  txIds: z.array(z.string().min(1)),
  submissionStatus: z
    .enum(["not_submitted", "maybe_submitted", "submitted"])
    .default("submitted"),
  submissionAmbiguous: z.boolean().optional(),
});

export const PartialClosePositionRequestSchema = z.object({
  wallet: z.string().min(1),
  positionId: z.string().min(1),
  closePercentage: z.number().positive().max(100),
  reason: z.string().min(1),
});

export const PartialClosePositionResultSchema = z.object({
  actionType: z.literal("PARTIAL_CLOSE"),
  closedPositionId: z.string().min(1),
  remainingPercentage: z.number().min(0).max(100),
  txIds: z.array(z.string().min(1)),
});

export const DlmmSimulationResultSchema = z
  .object({
    ok: z.boolean(),
    reason: z.string().min(1).nullable(),
  })
  .strict();

export const WalletPositionsSnapshotSchema = z
  .object({
    wallet: z.string().min(1),
    positions: z.array(PositionSchema),
  })
  .superRefine((snapshot, ctx) => {
    snapshot.positions.forEach((position, index) => {
      if (position.wallet !== snapshot.wallet) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["positions", index, "wallet"],
          message: `Position wallet ${position.wallet} does not match snapshot wallet ${snapshot.wallet}`,
        });
      }
    });
  });

export const PoolInfoSchema = z.object({
  poolAddress: z.string().min(1),
  pairLabel: z.string().min(1),
  binStep: z.number().int().positive(),
  activeBin: z.number().int(),
});

export type DeployLiquidityRequest = z.infer<
  typeof DeployLiquidityRequestSchema
>;
export type DeployLiquidityResult = z.infer<typeof DeployLiquidityResultSchema>;
export type DeployLiquidityResultInput = z.input<
  typeof DeployLiquidityResultSchema
>;
export type ClosePositionRequest = z.infer<typeof ClosePositionRequestSchema>;
export type ClosePositionResult = z.infer<typeof ClosePositionResultSchema>;
export type ClosePositionResultInput = z.input<
  typeof ClosePositionResultSchema
>;
export type ClaimFeesRequest = z.infer<typeof ClaimFeesRequestSchema>;
export type ClaimFeesResult = z.infer<typeof ClaimFeesResultSchema>;
export type ClaimFeesResultInput = z.input<typeof ClaimFeesResultSchema>;
export type PartialClosePositionRequest = z.infer<
  typeof PartialClosePositionRequestSchema
>;
export type PartialClosePositionResult = z.infer<
  typeof PartialClosePositionResultSchema
>;
export type PartialClosePositionResultInput = z.input<
  typeof PartialClosePositionResultSchema
>;
export type DlmmSimulationResult = z.infer<typeof DlmmSimulationResultSchema>;
export type WalletPositionsSnapshot = z.infer<
  typeof WalletPositionsSnapshotSchema
>;
export type PoolInfo = z.infer<typeof PoolInfoSchema>;

export interface DlmmGateway {
  readonly reconciliationReadModel?: "open_only";
  getPosition(positionId: string): Promise<Position | null>;
  deployLiquidity(
    request: DeployLiquidityRequest,
  ): Promise<DeployLiquidityResult>;
  simulateDeployLiquidity(
    request: DeployLiquidityRequest,
  ): Promise<DlmmSimulationResult>;
  closePosition(request: ClosePositionRequest): Promise<ClosePositionResult>;
  simulateClosePosition(
    request: ClosePositionRequest,
  ): Promise<DlmmSimulationResult>;
  claimFees(request: ClaimFeesRequest): Promise<ClaimFeesResult>;
  partialClosePosition(
    request: PartialClosePositionRequest,
  ): Promise<PartialClosePositionResult>;
  listPositionsForWallet(wallet: string): Promise<WalletPositionsSnapshot>;
  getPoolInfo(poolAddress: string): Promise<PoolInfo>;
}

export interface MockDlmmGatewayBehaviors {
  getPosition: MockBehavior<Position | null>;
  deployLiquidity: MockBehavior<DeployLiquidityResultInput>;
  simulateDeployLiquidity?: MockBehavior<DlmmSimulationResult>;
  closePosition: MockBehavior<ClosePositionResultInput>;
  simulateClosePosition?: MockBehavior<DlmmSimulationResult>;
  claimFees: MockBehavior<ClaimFeesResultInput>;
  partialClosePosition: MockBehavior<PartialClosePositionResultInput>;
  listPositionsForWallet: MockBehavior<WalletPositionsSnapshot>;
  getPoolInfo: MockBehavior<PoolInfo>;
}

export class MockDlmmGateway implements DlmmGateway {
  public constructor(private readonly behaviors: MockDlmmGatewayBehaviors) {}

  public async getPosition(_positionId: string): Promise<Position | null> {
    return PositionSchema.nullable().parse(
      await resolveMockBehavior(this.behaviors.getPosition),
    );
  }

  public async deployLiquidity(
    request: DeployLiquidityRequest,
  ): Promise<DeployLiquidityResult> {
    DeployLiquidityRequestSchema.parse(request);
    return DeployLiquidityResultSchema.parse(
      await resolveMockBehavior(this.behaviors.deployLiquidity),
    );
  }

  public async simulateDeployLiquidity(
    request: DeployLiquidityRequest,
  ): Promise<DlmmSimulationResult> {
    DeployLiquidityRequestSchema.parse(request);
    if (this.behaviors.simulateDeployLiquidity === undefined) {
      return DlmmSimulationResultSchema.parse({ ok: true, reason: null });
    }
    return DlmmSimulationResultSchema.parse(
      await resolveMockBehavior(this.behaviors.simulateDeployLiquidity),
    );
  }

  public async closePosition(
    request: ClosePositionRequest,
  ): Promise<ClosePositionResult> {
    ClosePositionRequestSchema.parse(request);
    return ClosePositionResultSchema.parse(
      await resolveMockBehavior(this.behaviors.closePosition),
    );
  }

  public async simulateClosePosition(
    request: ClosePositionRequest,
  ): Promise<DlmmSimulationResult> {
    ClosePositionRequestSchema.parse(request);
    if (this.behaviors.simulateClosePosition === undefined) {
      return DlmmSimulationResultSchema.parse({ ok: true, reason: null });
    }
    return DlmmSimulationResultSchema.parse(
      await resolveMockBehavior(this.behaviors.simulateClosePosition),
    );
  }

  public async claimFees(request: ClaimFeesRequest): Promise<ClaimFeesResult> {
    ClaimFeesRequestSchema.parse(request);
    return ClaimFeesResultSchema.parse(
      await resolveMockBehavior(this.behaviors.claimFees),
    );
  }

  public async partialClosePosition(
    request: PartialClosePositionRequest,
  ): Promise<PartialClosePositionResult> {
    PartialClosePositionRequestSchema.parse(request);
    return PartialClosePositionResultSchema.parse(
      await resolveMockBehavior(this.behaviors.partialClosePosition),
    );
  }

  public async listPositionsForWallet(
    wallet: string,
  ): Promise<WalletPositionsSnapshot> {
    const parsedWallet = z.string().min(1).parse(wallet);
    const snapshot = WalletPositionsSnapshotSchema.parse(
      await resolveMockBehavior(this.behaviors.listPositionsForWallet),
    );

    if (snapshot.wallet !== parsedWallet) {
      throw new Error(
        `Wallet positions snapshot wallet ${snapshot.wallet} does not match requested wallet ${parsedWallet}`,
      );
    }

    return snapshot;
  }

  public async getPoolInfo(_poolAddress: string): Promise<PoolInfo> {
    return PoolInfoSchema.parse(
      await resolveMockBehavior(this.behaviors.getPoolInfo),
    );
  }
}
