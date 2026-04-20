import { z } from "zod";

import { PositionSchema, type Position } from "../../domain/entities/Position.js";
import {
  type MockBehavior,
  resolveMockBehavior,
} from "../mockBehavior.js";

export const DeployLiquidityRequestSchema = z.object({
  wallet: z.string().min(1),
  poolAddress: z.string().min(1),
  amountBase: z.number().nonnegative(),
  amountQuote: z.number().nonnegative(),
  strategy: z.string().min(1),
});

export const DeployLiquidityResultSchema = z.object({
  actionType: z.literal("DEPLOY"),
  positionId: z.string().min(1),
  txIds: z.array(z.string().min(1)),
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
});

export const ClaimFeesRequestSchema = z.object({
  wallet: z.string().min(1),
  positionId: z.string().min(1),
});

export const ClaimFeesResultSchema = z.object({
  actionType: z.literal("CLAIM_FEES"),
  claimedBaseAmount: z.number().nonnegative(),
  txIds: z.array(z.string().min(1)),
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

export const WalletPositionsSnapshotSchema = z.object({
  wallet: z.string().min(1),
  positions: z.array(PositionSchema),
});

export const PoolInfoSchema = z.object({
  poolAddress: z.string().min(1),
  pairLabel: z.string().min(1),
  binStep: z.number().int().positive(),
  activeBin: z.number().int(),
});

export type DeployLiquidityRequest = z.infer<typeof DeployLiquidityRequestSchema>;
export type DeployLiquidityResult = z.infer<typeof DeployLiquidityResultSchema>;
export type ClosePositionRequest = z.infer<typeof ClosePositionRequestSchema>;
export type ClosePositionResult = z.infer<typeof ClosePositionResultSchema>;
export type ClaimFeesRequest = z.infer<typeof ClaimFeesRequestSchema>;
export type ClaimFeesResult = z.infer<typeof ClaimFeesResultSchema>;
export type PartialClosePositionRequest = z.infer<
  typeof PartialClosePositionRequestSchema
>;
export type PartialClosePositionResult = z.infer<
  typeof PartialClosePositionResultSchema
>;
export type WalletPositionsSnapshot = z.infer<typeof WalletPositionsSnapshotSchema>;
export type PoolInfo = z.infer<typeof PoolInfoSchema>;

export interface DlmmGateway {
  getPosition(positionId: string): Promise<Position | null>;
  deployLiquidity(request: DeployLiquidityRequest): Promise<DeployLiquidityResult>;
  closePosition(request: ClosePositionRequest): Promise<ClosePositionResult>;
  claimFees(request: ClaimFeesRequest): Promise<ClaimFeesResult>;
  partialClosePosition(
    request: PartialClosePositionRequest,
  ): Promise<PartialClosePositionResult>;
  listPositionsForWallet(wallet: string): Promise<WalletPositionsSnapshot>;
  getPoolInfo(poolAddress: string): Promise<PoolInfo>;
}

export interface MockDlmmGatewayBehaviors {
  getPosition: MockBehavior<Position | null>;
  deployLiquidity: MockBehavior<DeployLiquidityResult>;
  closePosition: MockBehavior<ClosePositionResult>;
  claimFees: MockBehavior<ClaimFeesResult>;
  partialClosePosition: MockBehavior<PartialClosePositionResult>;
  listPositionsForWallet: MockBehavior<WalletPositionsSnapshot>;
  getPoolInfo: MockBehavior<PoolInfo>;
}

export class MockDlmmGateway implements DlmmGateway {
  public constructor(private readonly behaviors: MockDlmmGatewayBehaviors) {}

  public async getPosition(_positionId: string): Promise<Position | null> {
    return resolveMockBehavior(this.behaviors.getPosition);
  }

  public async deployLiquidity(
    request: DeployLiquidityRequest,
  ): Promise<DeployLiquidityResult> {
    DeployLiquidityRequestSchema.parse(request);
    return DeployLiquidityResultSchema.parse(
      await resolveMockBehavior(this.behaviors.deployLiquidity),
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

  public async claimFees(
    request: ClaimFeesRequest,
  ): Promise<ClaimFeesResult> {
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
    _wallet: string,
  ): Promise<WalletPositionsSnapshot> {
    return WalletPositionsSnapshotSchema.parse(
      await resolveMockBehavior(this.behaviors.listPositionsForWallet),
    );
  }

  public async getPoolInfo(_poolAddress: string): Promise<PoolInfo> {
    return PoolInfoSchema.parse(
      await resolveMockBehavior(this.behaviors.getPoolInfo),
    );
  }
}
