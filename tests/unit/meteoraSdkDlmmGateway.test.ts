import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  sendAndConfirmTransactionMock,
  simulateTransactionMock,
  getParsedTransactionMock,
  poolCreateMock,
  getAllLbPairPositionsByUserMock,
  keypairFromSecretKeyMock,
  getParsedAccountInfoMock,
} = vi.hoisted(() => ({
  sendAndConfirmTransactionMock: vi.fn(async () => "tx_001"),
  simulateTransactionMock: vi.fn(async () => ({
    value: {
      err: null,
      logs: [],
    },
  })),
  getParsedTransactionMock: vi.fn(async () => null),
  poolCreateMock: vi.fn(),
  getAllLbPairPositionsByUserMock: vi.fn(),
  keypairFromSecretKeyMock: vi.fn(() => ({
    publicKey: {
      toBase58: () => "wallet_001",
    },
  })),
  getParsedAccountInfoMock: vi.fn(async () => ({
    value: {
      data: {
        parsed: {
          info: {
            decimals: 9,
          },
        },
      },
    },
  })),
}));

vi.mock("@solana/web3.js", () => ({
  Connection: class {
    public constructor(_url: string, _commitment: string) {}

    public async getParsedAccountInfo(_mint: unknown) {
      return getParsedAccountInfoMock(_mint);
    }

    public async simulateTransaction(tx: unknown, signers: unknown[]) {
      return simulateTransactionMock(tx, signers);
    }

    public async getParsedTransaction(txId: string, options: unknown) {
      return getParsedTransactionMock(txId, options);
    }
  },
  Keypair: {
    fromSecretKey: keypairFromSecretKeyMock,
    generate: () => ({
      publicKey: {
        toBase58: () => "generated_position",
      },
    }),
  },
  PublicKey: class {
    public constructor(private readonly value: string) {}

    public toBase58(): string {
      return this.value;
    }
  },
  sendAndConfirmTransaction: sendAndConfirmTransactionMock,
}));

vi.mock("@meteora-ag/dlmm", () => ({
  default: {
    create: poolCreateMock,
    getAllLbPairPositionsByUser: getAllLbPairPositionsByUserMock,
  },
  StrategyType: {
    Spot: "SPOT",
    Curve: "CURVE",
    BidAsk: "BID_ASK",
  },
}));

import { MeteoraSdkDlmmGateway } from "../../src/adapters/dlmm/MeteoraSdkDlmmGateway.js";

function createGateway(overrides: Partial<ConstructorParameters<typeof MeteoraSdkDlmmGateway>[0]> = {}) {
  return new MeteoraSdkDlmmGateway({
    rpcUrl: "https://rpc.example.com",
    walletPrivateKey: JSON.stringify(new Array(64).fill(1)),
    wallet: "wallet_001",
    ...overrides,
  });
}

function createPool(overrides: Record<string, unknown> = {}) {
  return {
    lbPair: {
      tokenXMint: { toBase58: () => "mint_x" },
      tokenYMint: { toBase58: () => "mint_y" },
      binStep: 80,
      activeId: 15,
    },
    getActiveBin: vi.fn(async () => ({ binId: 15 })),
    initializePositionAndAddLiquidityByStrategy: vi.fn(async () => ({ tx: "deploy" })),
    createExtendedEmptyPosition: vi.fn(async () => [{ tx: "create" }]),
    addLiquidityByStrategyChunkable: vi.fn(async () => [{ tx: "chunk" }]),
    getPosition: vi.fn(async () => ({
      positionData: {
        lowerBinId: 10,
        upperBinId: 20,
        positionBinData: [{ positionLiquidity: "1" }],
      },
    })),
    claimSwapFee: vi.fn(async () => [{ tx: "claim" }]),
    removeLiquidity: vi.fn(async () => ({ tx: "close" })),
    closePosition: vi.fn(async () => ({ tx: "close_empty" })),
    ...overrides,
  };
}

describe("MeteoraSdkDlmmGateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendAndConfirmTransactionMock.mockResolvedValue("tx_001");
    simulateTransactionMock.mockResolvedValue({
      value: {
        err: null,
        logs: [],
      },
    });
    getAllLbPairPositionsByUserMock.mockResolvedValue({});
    getParsedTransactionMock.mockResolvedValue(null);
    getParsedAccountInfoMock.mockResolvedValue({
      value: {
        data: {
          parsed: {
            info: {
              decimals: 9,
            },
          },
        },
      },
    });
  });

  it("forwards explicit slippageBps instead of hardcoded 1000 bps", async () => {
    const pool = createPool();
    poolCreateMock.mockResolvedValue(pool);
    const gateway = createGateway({
      defaultSlippageBps: 300,
    });

    await gateway.deployLiquidity({
      wallet: "wallet_001",
      poolAddress: "pool_001",
      tokenXMint: "mint_x",
      tokenYMint: "mint_y",
      baseMint: "mint_x",
      quoteMint: "mint_y",
      amountBase: 1,
      amountQuote: 1,
      slippageBps: 125,
      strategy: "bid_ask",
      rangeLowerBin: 10,
      rangeUpperBin: 20,
      initialActiveBin: 15,
    });

    expect(pool.initializePositionAndAddLiquidityByStrategy).toHaveBeenCalledWith(
      expect.objectContaining({
        slippage: 125,
      }),
    );
  });

  it("falls back to SDK with real token mints when Meteora data API is unavailable", async () => {
    const pool = createPool();
    poolCreateMock.mockResolvedValue(pool);
    getAllLbPairPositionsByUserMock.mockResolvedValue({
      pool_001: {
        lbPairPositionsData: [
          {
            publicKey: {
              toString: () => "pos_001",
            },
          },
        ],
      },
    });
    const gateway = createGateway({
      fetchFn: vi.fn(async () => {
        throw new Error("data api unavailable");
      }),
    });

    const snapshot = await gateway.listPositionsForWallet("wallet_001");

    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0]?.tokenXMint).toBe("mint_x");
    expect(snapshot.positions[0]?.tokenYMint).toBe("mint_y");
    expect(snapshot.positions[0]?.rangeLowerBin).toBe(10);
    expect(snapshot.positions[0]?.rangeUpperBin).toBe(20);
  });

  it("fails fast instead of using fabricated close ranges when position range cannot be loaded", async () => {
    const pool = createPool({
      getPosition: vi.fn(async () => {
        throw new Error("position lookup failed");
      }),
    });
    poolCreateMock.mockResolvedValue(pool);
    const gateway = createGateway();
    ((gateway as unknown as {
      poolByPositionId: Map<string, { value: string; cachedAtMs: number }>;
    }).poolByPositionId).set("pos_001", {
      value: "pool_001",
      cachedAtMs: Date.now(),
    });

    await expect(
      gateway.closePosition({
        wallet: "wallet_001",
        positionId: "pos_001",
        reason: "manual",
      }),
    ).rejects.toThrow(
      "close requires a readable Meteora position snapshot for pos_001: position lookup failed",
    );
    expect(pool.removeLiquidity).not.toHaveBeenCalled();
  });

  it("surfaces pre-close fee-claim failure instead of swallowing it silently", async () => {
    const pool = createPool({
      claimSwapFee: vi.fn(async () => {
        throw new Error("claim before close failed");
      }),
    });
    poolCreateMock.mockResolvedValue(pool);
    const gateway = createGateway();
    ((gateway as unknown as {
      poolByPositionId: Map<string, { value: string; cachedAtMs: number }>;
    }).poolByPositionId).set("pos_001", {
      value: "pool_001",
      cachedAtMs: Date.now(),
    });

    const result = await gateway.closePosition({
      wallet: "wallet_001",
      positionId: "pos_001",
      reason: "manual",
    });

    expect(result.preCloseFeesClaimed).toBe(false);
    expect(result.preCloseFeesClaimError).toContain("claim before close failed");
  });

  it("caches token decimals and simulates transactions before submit", async () => {
    const pool = createPool();
    poolCreateMock.mockResolvedValue(pool);
    const gateway = createGateway();

    await gateway.deployLiquidity({
      wallet: "wallet_001",
      poolAddress: "pool_001",
      tokenXMint: "mint_x",
      tokenYMint: "mint_y",
      baseMint: "mint_x",
      quoteMint: "mint_y",
      amountBase: 1,
      amountQuote: 0,
      strategy: "bid_ask",
      rangeLowerBin: 10,
      rangeUpperBin: 20,
      initialActiveBin: 15,
    });

    await gateway.deployLiquidity({
      wallet: "wallet_001",
      poolAddress: "pool_001",
      tokenXMint: "mint_x",
      tokenYMint: "mint_y",
      baseMint: "mint_x",
      quoteMint: "mint_y",
      amountBase: 2,
      amountQuote: 2,
      strategy: "bid_ask",
      rangeLowerBin: 10,
      rangeUpperBin: 20,
      initialActiveBin: 15,
    });

    expect(getParsedAccountInfoMock).toHaveBeenCalledTimes(2);
    expect(simulateTransactionMock).toHaveBeenCalled();
    expect(sendAndConfirmTransactionMock).toHaveBeenCalled();
  });

  it("rejects wallet private keys that do not decode to 64 bytes", () => {
    expect(
      () =>
        new MeteoraSdkDlmmGateway({
          rpcUrl: "https://rpc.example.com",
          walletPrivateKey: JSON.stringify([1, 2, 3]),
          wallet: "wallet_001",
        }),
    ).toThrow("WALLET_PRIVATE_KEY must decode to 64 bytes");
  });

  it("rejects wallet address mismatch between public wallet and signer key", () => {
    expect(
      () =>
        new MeteoraSdkDlmmGateway({
          rpcUrl: "https://rpc.example.com",
          walletPrivateKey: JSON.stringify(new Array(64).fill(1)),
          wallet: "wallet_other",
        }),
    ).toThrow("PUBLIC_WALLET_ADDRESS must match WALLET_PRIVATE_KEY");
  });

  it("fails before submit when transaction simulation reports an error", async () => {
    const pool = createPool();
    poolCreateMock.mockResolvedValue(pool);
    simulateTransactionMock.mockResolvedValue({
      value: {
        err: { instructionError: [0, "Custom"] },
        logs: ["simulation failed"],
      },
    });
    const gateway = createGateway();

    await expect(
      gateway.deployLiquidity({
        wallet: "wallet_001",
        poolAddress: "pool_001",
        tokenXMint: "mint_x",
        tokenYMint: "mint_y",
        baseMint: "mint_x",
        quoteMint: "mint_y",
        amountBase: 1,
        amountQuote: 0,
        strategy: "bid_ask",
        rangeLowerBin: 10,
        rangeUpperBin: 20,
        initialActiveBin: 15,
      }),
    ).rejects.toThrow("Meteora transaction simulation failed: simulation failed");

    expect(sendAndConfirmTransactionMock).not.toHaveBeenCalled();
  });

  it("marks claimed base amount source as unavailable instead of silently pretending 0 is accurate", async () => {
    const pool = createPool();
    poolCreateMock.mockResolvedValue(pool);
    const gateway = createGateway({
      fetchFn: vi.fn(async () =>
        new Response(JSON.stringify({ pools: [] }), { status: 200 })),
    });
    ((gateway as unknown as {
      poolByPositionId: Map<string, { value: string; cachedAtMs: number }>;
    }).poolByPositionId).set("pos_001", {
      value: "pool_001",
      cachedAtMs: Date.now(),
    });

    const result = await gateway.claimFees({
      wallet: "wallet_001",
      positionId: "pos_001",
    });

    expect(result.claimedBaseAmount).toBe(0);
    expect(result.claimedBaseAmountSource).toBe("unavailable");
  });

  it("uses post-transaction token balance delta for claimed base amount when available", async () => {
    const pool = createPool();
    poolCreateMock.mockResolvedValue(pool);
    sendAndConfirmTransactionMock.mockResolvedValue("tx_claim");
    getParsedTransactionMock.mockResolvedValue({
      meta: {
        preTokenBalances: [
          {
            accountIndex: 3,
            owner: "wallet_001",
            mint: "mint_x",
            uiTokenAmount: {
              uiAmountString: "1.25",
            },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 3,
            owner: "wallet_001",
            mint: "mint_x",
            uiTokenAmount: {
              uiAmountString: "1.75",
            },
          },
        ],
      },
    });
    const gateway = createGateway({
      fetchFn: vi.fn(async () =>
        new Response(JSON.stringify({ pools: [] }), { status: 200 })),
    });
    ((gateway as unknown as {
      poolByPositionId: Map<string, { value: string; cachedAtMs: number }>;
    }).poolByPositionId).set("pos_001", {
      value: "pool_001",
      cachedAtMs: Date.now(),
    });

    const result = await gateway.claimFees({
      wallet: "wallet_001",
      positionId: "pos_001",
    });

    expect(getParsedTransactionMock).toHaveBeenCalledWith("tx_claim", {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    expect(result.claimedBaseAmount).toBe(0.5);
    expect(result.claimedBaseAmountSource).toBe("post_tx");
  });

  it("retries transient RPC send errors before succeeding", async () => {
    const pool = createPool();
    poolCreateMock.mockResolvedValue(pool);
    sendAndConfirmTransactionMock
      .mockRejectedValueOnce(new Error("Blockhash not found"))
      .mockResolvedValueOnce("tx_retry_ok");
    const gateway = createGateway();

    const result = await gateway.deployLiquidity({
      wallet: "wallet_001",
      poolAddress: "pool_001",
      tokenXMint: "mint_x",
      tokenYMint: "mint_y",
      baseMint: "mint_x",
      quoteMint: "mint_y",
      amountBase: 1,
      amountQuote: 0,
      strategy: "bid_ask",
      rangeLowerBin: 10,
      rangeUpperBin: 20,
      initialActiveBin: 15,
    });

    expect(sendAndConfirmTransactionMock).toHaveBeenCalledTimes(2);
    expect(result.txIds).toEqual(["tx_retry_ok"]);
  });
});
