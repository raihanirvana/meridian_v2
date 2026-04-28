import { z } from "zod";

import { type MockBehavior, resolveMockBehavior } from "../mockBehavior.js";

export const SwapQuoteRequestSchema = z.object({
  inputMint: z.string().min(1),
  outputMint: z.string().min(1),
  amount: z.number().positive(),
});

export const SwapQuoteResultSchema = z.object({
  expectedOutputAmount: z.number().nonnegative(),
  expectedOutputAmountRaw: z.string().regex(/^\d+$/).optional(),
  // Canonical unit: fractional ratio, where 0.01 = 1%.
  priceImpactPct: z.number().nonnegative(),
});

export const ExecuteSwapRequestSchema = SwapQuoteRequestSchema.extend({
  wallet: z.string().min(1),
  amountRaw: z.string().regex(/^\d+$/).optional(),
});

export const ExecuteSwapResultSchema = z.object({
  txId: z.string().min(1),
  inputAmount: z.number().nonnegative(),
  inputAmountRaw: z.string().regex(/^\d+$/).optional(),
  outputAmount: z.number().nonnegative(),
  outputAmountRaw: z.string().regex(/^\d+$/).optional(),
});

export type SwapQuoteRequest = z.infer<typeof SwapQuoteRequestSchema>;
export type SwapQuoteResult = z.infer<typeof SwapQuoteResultSchema>;
export type ExecuteSwapRequest = z.infer<typeof ExecuteSwapRequestSchema>;
export type ExecuteSwapResult = z.infer<typeof ExecuteSwapResultSchema>;

export interface SwapGateway {
  quoteSwap(request: SwapQuoteRequest): Promise<SwapQuoteResult>;
  executeSwap(request: ExecuteSwapRequest): Promise<ExecuteSwapResult>;
}

export interface MockSwapGatewayBehaviors {
  quoteSwap: MockBehavior<SwapQuoteResult>;
  executeSwap: MockBehavior<ExecuteSwapResult>;
}

export class MockSwapGateway implements SwapGateway {
  public constructor(private readonly behaviors: MockSwapGatewayBehaviors) {}

  public async quoteSwap(request: SwapQuoteRequest): Promise<SwapQuoteResult> {
    SwapQuoteRequestSchema.parse(request);
    return SwapQuoteResultSchema.parse(
      await resolveMockBehavior(this.behaviors.quoteSwap),
    );
  }

  public async executeSwap(
    request: ExecuteSwapRequest,
  ): Promise<ExecuteSwapResult> {
    ExecuteSwapRequestSchema.parse(request);
    return ExecuteSwapResultSchema.parse(
      await resolveMockBehavior(this.behaviors.executeSwap),
    );
  }
}
