import { z } from "zod";

import { type MockBehavior, resolveMockBehavior } from "../mockBehavior.js";

export const SwapQuoteRequestSchema = z.object({
  inputMint: z.string().min(1),
  outputMint: z.string().min(1),
  amountRaw: z.string().regex(/^\d+$/),
});

export const SwapQuoteResultSchema = z.object({
  expectedOutputAmountRaw: z.string().regex(/^\d+$/),
  expectedOutputAmountUi: z.number().nonnegative().optional(),
  // Canonical unit: fractional ratio, where 0.01 = 1%.
  priceImpactPct: z.number().nonnegative(),
});

export const ExecuteSwapRequestSchema = z.object({
  inputMint: z.string().min(1),
  outputMint: z.string().min(1),
  amountRaw: z.string().regex(/^\d+$/),
  wallet: z.string().min(1),
});

export const ExecuteSwapResultSchema = z.object({
  txId: z.string().min(1),
  inputAmountRaw: z.string().regex(/^\d+$/),
  inputAmountUi: z.number().nonnegative().optional(),
  outputAmountRaw: z.string().regex(/^\d+$/),
  // UI-unit output amount (human-readable, e.g. 0.25 SOL not 250000000 lamports).
  // Required for auto-compound deploy; adapters that only return raw atomic amounts
  // must leave this undefined, which will cause auto-compound to fail explicitly.
  outputAmountUi: z.number().nonnegative().optional(),
  outputAmountUsd: z.number().nonnegative().optional(),
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
