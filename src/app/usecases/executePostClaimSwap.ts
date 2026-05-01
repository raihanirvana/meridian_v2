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

const SOL_MINT = "So11111111111111111111111111111111111111112";
const DEFAULT_MIN_POST_CLOSE_SOL_OUTPUT_RATIO = 0.75;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown swap error";
}

function solUiToRawLamports(amountSol: number): bigint {
  return BigInt(Math.floor(amountSol * 1_000_000_000));
}

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

    try {
      if (
        parsed.position.quoteMint === SOL_MINT &&
        parsed.position.deployAmountQuote > 0
      ) {
        const quote = await swapGateway.quoteSwap({
          inputMint: parsed.position.baseMint,
          outputMint: parsed.position.quoteMint,
          amountRaw,
        });
        const minimumOutputRaw = solUiToRawLamports(
          parsed.position.deployAmountQuote *
            DEFAULT_MIN_POST_CLOSE_SOL_OUTPUT_RATIO,
        );
        const quotedOutputRaw = BigInt(quote.expectedOutputAmountRaw);

        if (quotedOutputRaw < minimumOutputRaw) {
          return {
            swapIntentId: parsed.swapIntentId,
            status: "SKIPPED",
            reason: "post-close swap quote below minimum SOL recovery guard",
            quotedOutputRaw: quote.expectedOutputAmountRaw,
            minimumOutputRaw: minimumOutputRaw.toString(),
            priceImpactPct: quote.priceImpactPct,
          };
        }
      }

      const result = await swapGateway.executeSwap({
        wallet: parsed.wallet,
        inputMint: parsed.position.baseMint,
        outputMint: parsed.position.quoteMint,
        amountRaw,
      });
      return {
        swapIntentId: parsed.swapIntentId,
        status: "DONE",
        ...ExecuteSwapResultSchema.parse(result),
      };
    } catch (error) {
      return {
        swapIntentId: parsed.swapIntentId,
        status: "FAILED",
        reason: errorMessage(error),
      };
    }
  };
}
