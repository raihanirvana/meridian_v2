import { describe, expect, it } from "vitest";

import { MockTokenIntelGateway } from "../../src/adapters/analytics/TokenIntelGateway.js";
import { MockDlmmGateway } from "../../src/adapters/dlmm/DlmmGateway.js";
import { MockSwapGateway } from "../../src/adapters/jupiter/SwapGateway.js";
import { MockLlmGateway } from "../../src/adapters/llm/LlmGateway.js";
import { MockScreeningGateway } from "../../src/adapters/screening/ScreeningGateway.js";
import { MockNotifierGateway } from "../../src/adapters/telegram/NotifierGateway.js";

const validPositionSnapshot = {
  positionId: "pos_001",
  poolAddress: "pool_001",
  tokenXMint: "mint_x",
  tokenYMint: "mint_y",
  baseMint: "mint_base",
  quoteMint: "mint_quote",
  wallet: "wallet_001",
  status: "OPEN",
  openedAt: "2026-04-20T00:00:00.000Z",
  lastSyncedAt: "2026-04-20T00:00:00.000Z",
  closedAt: null,
  deployAmountBase: 1,
  deployAmountQuote: 0.5,
  currentValueBase: 1,
  currentValueUsd: 100,
  feesClaimedBase: 0,
  feesClaimedUsd: 0,
  realizedPnlBase: 0,
  realizedPnlUsd: 0,
  unrealizedPnlBase: 0,
  unrealizedPnlUsd: 0,
  rebalanceCount: 0,
  partialCloseCount: 0,
  strategy: "bid_ask",
  rangeLowerBin: 10,
  rangeUpperBin: 20,
  activeBin: 25,
  outOfRangeSince: "2026-04-20T01:00:00.000Z",
  lastManagementDecision: null,
  lastManagementReason: null,
  lastWriteActionId: null,
  needsReconciliation: false,
} as const;

describe("mock gateways", () => {
  it("can simulate success responses", async () => {
    const dlmm = new MockDlmmGateway({
      getPosition: { type: "success", value: null },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_001",
          txIds: ["tx_001"],
        },
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "pos_001",
          txIds: ["tx_002"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 1.25,
          txIds: ["tx_003"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "pos_001",
          remainingPercentage: 50,
          txIds: ["tx_004"],
        },
      },
      listPositionsForWallet: {
        type: "success",
        value: {
          wallet: "wallet_001",
          positions: [],
        },
      },
      getPoolInfo: {
        type: "success",
        value: {
          poolAddress: "pool_001",
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 123,
        },
      },
    });

    const swap = new MockSwapGateway({
      quoteSwap: {
        type: "success",
        value: {
          expectedOutputAmount: 95,
          priceImpactPct: 0.3,
        },
      },
      executeSwap: {
        type: "success",
        value: {
          txId: "swap_tx_001",
          inputAmount: 100,
          outputAmount: 95,
        },
      },
    });

    const screening = new MockScreeningGateway({
      listCandidates: { type: "success", value: [] },
      getCandidateDetails: {
        type: "success",
        value: {
          poolAddress: "pool_001",
          pairLabel: "SOL-USDC",
          feeToTvlRatio: 0.08,
          organicScore: 75,
          holderCount: 1200,
        },
      },
    });

    const analytics = new MockTokenIntelGateway({
      getTokenRiskSnapshot: {
        type: "success",
        value: {
          tokenMint: "mint_001",
          riskScore: 12,
          topHolderPct: 18,
          botHolderPct: 3,
        },
      },
      getSmartMoneySnapshot: {
        type: "success",
        value: {
          tokenMint: "mint_001",
          smartWalletCount: 4,
          confidenceScore: 81,
        },
      },
    });

    const llm = new MockLlmGateway({
      rankCandidates: {
        type: "success",
        value: {
          rankedCandidateIds: ["cand_001"],
          reasoning: "Best deterministic profile",
        },
      },
      explainManagementDecision: {
        type: "success",
        value: {
          action: "HOLD",
          reasoning: "Still inside range",
        },
      },
    });

    const notifier = new MockNotifierGateway({
      sendMessage: {
        type: "success",
        value: {
          delivered: true,
          channel: "telegram",
          recipient: "chat_001",
        },
      },
      sendAlert: {
        type: "success",
        value: {
          delivered: true,
          channel: "telegram",
          recipient: "chat_001",
        },
      },
    });

    await expect(
      dlmm.deployLiquidity({
        wallet: "wallet_001",
        poolAddress: "pool_001",
        amountBase: 1,
        amountQuote: 0.5,
        strategy: "bid_ask",
      }),
    ).resolves.toMatchObject({ positionId: "pos_001" });

    await expect(
      swap.quoteSwap({
        inputMint: "SOL",
        outputMint: "USDC",
        amount: 100,
      }),
    ).resolves.toMatchObject({ expectedOutputAmount: 95 });

    await expect(screening.listCandidates({ limit: 5 })).resolves.toEqual([]);
    await expect(
      analytics.getTokenRiskSnapshot("mint_001"),
    ).resolves.toMatchObject({ riskScore: 12 });
    await expect(llm.rankCandidates([])).resolves.toMatchObject({
      rankedCandidateIds: ["cand_001"],
    });
    await expect(
      llm.explainManagementDecision({
        positionId: "pos_001",
        proposedAction: "HOLD",
        positionSnapshot: validPositionSnapshot,
        triggerReasons: ["still in range"],
      }),
    ).resolves.toMatchObject({
      action: "HOLD",
    });
    await expect(
      notifier.sendMessage({
        recipient: "chat_001",
        message: "hello",
      }),
    ).resolves.toMatchObject({ delivered: true });
  });

  it("can simulate failures", async () => {
    const failingDlmm = new MockDlmmGateway({
      getPosition: { type: "success", value: null },
      deployLiquidity: { type: "fail", error: "deploy failed" },
      closePosition: { type: "fail", error: "close failed" },
      claimFees: { type: "fail", error: "claim failed" },
      partialClosePosition: { type: "fail", error: "partial close failed" },
      listPositionsForWallet: { type: "fail", error: "list failed" },
      getPoolInfo: { type: "fail", error: "pool info failed" },
    });

    const failingLlm = new MockLlmGateway({
      rankCandidates: { type: "fail", error: "llm unavailable" },
      explainManagementDecision: { type: "fail", error: "llm unavailable" },
    });

    await expect(
      failingDlmm.deployLiquidity({
        wallet: "wallet_001",
        poolAddress: "pool_001",
        amountBase: 1,
        amountQuote: 0.5,
        strategy: "bid_ask",
      }),
    ).rejects.toThrow(/deploy failed/i);

    await expect(failingLlm.rankCandidates([])).rejects.toThrow(
      /llm unavailable/i,
    );
  });

  it("can simulate timeouts", async () => {
    const timeoutSwap = new MockSwapGateway({
      quoteSwap: { type: "timeout", timeoutMs: 5 },
      executeSwap: { type: "timeout", timeoutMs: 5 },
    });

    const timeoutNotifier = new MockNotifierGateway({
      sendMessage: { type: "timeout", timeoutMs: 5 },
      sendAlert: { type: "timeout", timeoutMs: 5 },
    });

    await expect(
      timeoutSwap.executeSwap({
        wallet: "wallet_001",
        inputMint: "SOL",
        outputMint: "USDC",
        amount: 50,
      }),
    ).rejects.toThrow(/timeout/i);

    await expect(
      timeoutNotifier.sendAlert({
        recipient: "chat_001",
        title: "Alert",
        body: "Queue stuck",
      }),
    ).rejects.toThrow(/timeout/i);
  });

  it("rejects invalid boundary payloads", async () => {
    const invalidDlmm = new MockDlmmGateway({
      getPosition: { type: "success", value: null },
      deployLiquidity: {
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: "pos_001",
          txIds: ["tx_001"],
        },
      },
      closePosition: {
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: "pos_001",
          txIds: ["tx_002"],
        },
      },
      claimFees: {
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 1,
          txIds: ["tx_003"],
        },
      },
      partialClosePosition: {
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: "pos_001",
          remainingPercentage: 50,
          txIds: ["tx_004"],
        },
      },
      listPositionsForWallet: {
        type: "success",
        value: {
          wallet: "wallet_001",
          positions: [
            {
              ...validPositionSnapshot,
              rangeLowerBin: 20,
              rangeUpperBin: 10,
            },
          ],
        },
      },
      getPoolInfo: {
        type: "success",
        value: {
          poolAddress: "pool_001",
          pairLabel: "SOL-USDC",
          binStep: 100,
          activeBin: 123,
        },
      },
    });

    const invalidAnalytics = new MockTokenIntelGateway({
      getTokenRiskSnapshot: {
        type: "success",
        value: {
          tokenMint: "mint_001",
          riskScore: 120,
          topHolderPct: 18,
          botHolderPct: 3,
        },
      },
      getSmartMoneySnapshot: {
        type: "success",
        value: {
          tokenMint: "mint_001",
          smartWalletCount: 4,
          confidenceScore: 81,
        },
      },
    });

    const invalidSwap = new MockSwapGateway({
      quoteSwap: {
        type: "success",
        value: {
          expectedOutputAmount: 95,
          priceImpactPct: 0.3,
        },
      },
      executeSwap: {
        type: "success",
        value: {
          txId: "swap_tx_001",
          inputAmount: 100,
          outputAmount: 95,
        },
      },
    });

    const invalidLlm = new MockLlmGateway({
      rankCandidates: {
        type: "success",
        value: {
          rankedCandidateIds: ["cand_001"],
          reasoning: "Best deterministic profile",
        },
      },
      explainManagementDecision: {
        type: "success",
        value: {
          action: "HOLD",
          reasoning: "Still inside range",
        },
      },
    });

    const invalidNotifier = new MockNotifierGateway({
      sendMessage: {
        type: "success",
        value: {
          delivered: true,
          channel: "email",
          recipient: "chat_001",
        },
      },
      sendAlert: {
        type: "success",
        value: {
          delivered: true,
          channel: "telegram",
          recipient: "chat_001",
        },
      },
    });

    await expect(
      invalidDlmm.listPositionsForWallet("wallet_001"),
    ).rejects.toThrow();

    await expect(
      invalidAnalytics.getTokenRiskSnapshot("mint_001"),
    ).rejects.toThrow();

    await expect(
      invalidSwap.executeSwap({
        wallet: "wallet_001",
        inputMint: "SOL",
        outputMint: "USDC",
        amount: 0,
      }),
    ).rejects.toThrow();

    await expect(
      invalidLlm.explainManagementDecision({
        positionId: "pos_001",
        proposedAction: "HOLD",
        positionSnapshot: {
          ...validPositionSnapshot,
          openedAt: null,
        },
        triggerReasons: ["still in range"],
      }),
    ).rejects.toThrow();

    await expect(
      invalidNotifier.sendMessage({
        recipient: "chat_001",
        message: "hello",
      }),
    ).rejects.toThrow();
  });
});
