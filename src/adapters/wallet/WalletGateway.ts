import { z } from "zod";

import { type MockBehavior, resolveMockBehavior } from "../mockBehavior.js";

export const WalletBalanceSnapshotSchema = z
  .object({
    wallet: z.string().min(1),
    balanceSol: z.number().nonnegative(),
    asOf: z.string().datetime(),
  })
  .strict();

export type WalletBalanceSnapshot = z.infer<typeof WalletBalanceSnapshotSchema>;

export interface WalletGateway {
  getWalletBalance(wallet: string): Promise<WalletBalanceSnapshot>;
}

export interface MockWalletGatewayBehaviors {
  getWalletBalance: MockBehavior<WalletBalanceSnapshot>;
}

export class MockWalletGateway implements WalletGateway {
  public constructor(private readonly behaviors: MockWalletGatewayBehaviors) {}

  public async getWalletBalance(
    _wallet: string,
  ): Promise<WalletBalanceSnapshot> {
    return WalletBalanceSnapshotSchema.parse(
      await resolveMockBehavior(this.behaviors.getWalletBalance),
    );
  }
}
