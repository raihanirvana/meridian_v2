import {
  ExecuteSwapResultSchema,
  type SwapGateway,
} from "../../adapters/jupiter/SwapGateway.js";

import {
  PostClaimSwapInputSchema,
  type PostClaimSwapHook,
} from "./finalizeClaimFees.js";

export function createPostClaimSwapHook(
  swapGateway: SwapGateway,
): PostClaimSwapHook {
  return async (input) => {
    const parsed = PostClaimSwapInputSchema.parse(input);
    if (parsed.claimedBaseAmountRaw === undefined) {
      throw new Error(
        "claimedBaseAmountRaw is required for swap execution; raw atomic amount unavailable from claim result",
      );
    }
    const result = await swapGateway.executeSwap({
      wallet: parsed.wallet,
      inputMint: parsed.position.baseMint,
      outputMint: parsed.outputMint,
      amountRaw: parsed.claimedBaseAmountRaw,
    });
    return ExecuteSwapResultSchema.parse(result);
  };
}
