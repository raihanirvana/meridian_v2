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
    const result = await swapGateway.executeSwap({
      wallet: parsed.wallet,
      inputMint: parsed.position.baseMint,
      outputMint: parsed.outputMint,
      amount: parsed.claimedBaseAmount,
    });
    return ExecuteSwapResultSchema.parse(result);
  };
}
