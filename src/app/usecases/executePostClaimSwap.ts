import {
  ExecuteSwapResultSchema,
  type SwapGateway,
} from "../../adapters/jupiter/SwapGateway.js";

import {
  PostClaimSwapInputSchema,
  type PostClaimSwapHook,
} from "./finalizeClaimFees.js";
import {
  PostCloseSwapInputSchema,
  type PostCloseSwapHook,
} from "./finalizeClose.js";

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

export function createPostCloseSwapHook(
  swapGateway: SwapGateway,
): PostCloseSwapHook {
  return async (input) => {
    const parsed = PostCloseSwapInputSchema.parse(input);
    const amountRaw = parsed.closeResult.releasedAmountBaseRaw;
    if (parsed.position.baseMint === parsed.position.quoteMint) {
      return {
        swapIntentId: parsed.swapIntentId,
        status: "SKIPPED",
        reason: "base and quote mint are identical",
      };
    }
    if (amountRaw === undefined || BigInt(amountRaw) <= 0n) {
      return {
        swapIntentId: parsed.swapIntentId,
        status: "SKIPPED",
        reason: "released base raw amount unavailable",
      };
    }

    const result = await swapGateway.executeSwap({
      wallet: parsed.wallet,
      inputMint: parsed.position.baseMint,
      outputMint: parsed.position.quoteMint,
      amountRaw,
    });
    return {
      swapIntentId: parsed.swapIntentId,
      ...ExecuteSwapResultSchema.parse(result),
    };
  };
}
