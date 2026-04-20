import { z } from "zod";

import {
  type MockBehavior,
  resolveMockBehavior,
} from "../mockBehavior.js";

export const TokenRiskSnapshotSchema = z.object({
  tokenMint: z.string().min(1),
  riskScore: z.number().min(0).max(100),
  topHolderPct: z.number().min(0).max(100),
  botHolderPct: z.number().min(0).max(100),
});

export const SmartMoneySnapshotSchema = z.object({
  tokenMint: z.string().min(1),
  smartWalletCount: z.number().int().nonnegative(),
  confidenceScore: z.number().min(0).max(100),
});

export type TokenRiskSnapshot = z.infer<typeof TokenRiskSnapshotSchema>;
export type SmartMoneySnapshot = z.infer<typeof SmartMoneySnapshotSchema>;

export interface TokenIntelGateway {
  getTokenRiskSnapshot(tokenMint: string): Promise<TokenRiskSnapshot>;
  getSmartMoneySnapshot(tokenMint: string): Promise<SmartMoneySnapshot>;
}

export interface MockTokenIntelGatewayBehaviors {
  getTokenRiskSnapshot: MockBehavior<TokenRiskSnapshot>;
  getSmartMoneySnapshot: MockBehavior<SmartMoneySnapshot>;
}

export class MockTokenIntelGateway implements TokenIntelGateway {
  public constructor(
    private readonly behaviors: MockTokenIntelGatewayBehaviors,
  ) {}

  public async getTokenRiskSnapshot(
    tokenMint: string,
  ): Promise<TokenRiskSnapshot> {
    z.string().min(1).parse(tokenMint);
    return TokenRiskSnapshotSchema.parse(
      await resolveMockBehavior(this.behaviors.getTokenRiskSnapshot),
    );
  }

  public async getSmartMoneySnapshot(
    tokenMint: string,
  ): Promise<SmartMoneySnapshot> {
    z.string().min(1).parse(tokenMint);
    return SmartMoneySnapshotSchema.parse(
      await resolveMockBehavior(this.behaviors.getSmartMoneySnapshot),
    );
  }
}
