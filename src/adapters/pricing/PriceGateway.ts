import { z } from "zod";

import {
  type MockBehavior,
  resolveMockBehavior,
} from "../mockBehavior.js";

export const SolPriceQuoteSchema = z
  .object({
    symbol: z.literal("SOL"),
    priceUsd: z.number().positive(),
    asOf: z.string().datetime(),
  })
  .strict();

export type SolPriceQuote = z.infer<typeof SolPriceQuoteSchema>;

export interface PriceGateway {
  getSolPriceUsd(): Promise<SolPriceQuote>;
}

export interface MockPriceGatewayBehaviors {
  getSolPriceUsd: MockBehavior<SolPriceQuote>;
}

export class MockPriceGateway implements PriceGateway {
  public constructor(private readonly behaviors: MockPriceGatewayBehaviors) {}

  public async getSolPriceUsd(): Promise<SolPriceQuote> {
    return SolPriceQuoteSchema.parse(
      await resolveMockBehavior(this.behaviors.getSolPriceUsd),
    );
  }
}
