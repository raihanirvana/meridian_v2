import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { z } from "zod";

import {
  AdapterHttpStatusError,
  AdapterResponseValidationError,
  AdapterTransportError,
  JsonHttpClient,
  type FetchLike,
} from "../http/HttpJsonClient.js";
import {
  PositionSchema,
  type Position,
} from "../../domain/entities/Position.js";
import {
  ClaimFeesRequestSchema,
  ClaimFeesResultSchema,
  ClosePositionRequestSchema,
  ClosePositionResultSchema,
  DeployLiquidityRequestSchema,
  DeployLiquidityResultSchema,
  PartialClosePositionRequestSchema,
  PartialClosePositionResultSchema,
  PoolInfoSchema,
  WalletPositionsSnapshotSchema,
  type ClaimFeesRequest,
  type ClaimFeesResult,
  type ClosePositionRequest,
  type ClosePositionResult,
  type DeployLiquidityRequest,
  type DeployLiquidityResult,
  type DlmmGateway,
  type PartialClosePositionRequest,
  type PartialClosePositionResult,
  type PoolInfo,
  type WalletPositionsSnapshot,
} from "./DlmmGateway.js";

const DefaultDataApiBaseUrl = "https://dlmm.datapi.meteora.ag";
const DefaultDataApiTimeoutMs = 15_000;
const DefaultSlippageBps = 300;
const DefaultMaxActiveBinDrift = 3;
const PositionsCacheTtlMs = 5_000;
const GatewayEntryCacheTtlMs = 60 * 60 * 1000;
const WideRangeBinThreshold = 69;
const FullCloseBps = 10_000;
const RpcSubmitRetryDelaysMs = [250, 750];

type StrategyTypeValue = unknown;

interface MeteoraSdkModule {
  default: {
    create(
      connection: Connection,
      poolAddress: PublicKey,
    ): Promise<MeteoraPoolLike>;
    getAllLbPairPositionsByUser(
      connection: Connection,
      user: PublicKey,
    ): Promise<
      Record<
        string,
        { lbPairPositionsData?: Array<{ publicKey: { toString(): string } }> }
      >
    >;
  };
  StrategyType: {
    Spot: StrategyTypeValue;
    Curve: StrategyTypeValue;
    BidAsk: StrategyTypeValue;
  };
}

interface MeteoraPoolLike {
  lbPair: {
    tokenXMint: PublicKey;
    tokenYMint: PublicKey;
    binStep?: number;
    activeId?: number;
  };
  getActiveBin(): Promise<{ binId: number; price?: unknown }>;
  initializePositionAndAddLiquidityByStrategy(
    input: Record<string, unknown>,
  ): Promise<unknown>;
  createExtendedEmptyPosition(
    minBinId: number,
    maxBinId: number,
    positionPubkey: PublicKey,
    owner: PublicKey,
  ): Promise<unknown | unknown[]>;
  addLiquidityByStrategyChunkable(
    input: Record<string, unknown>,
  ): Promise<unknown | unknown[]>;
  getPosition(positionAddress: PublicKey): Promise<{
    positionData?: {
      lowerBinId?: number;
      upperBinId?: number;
      positionBinData?: Array<{ positionLiquidity?: string | number }>;
    };
  }>;
  claimSwapFee(input: Record<string, unknown>): Promise<unknown[]>;
  removeLiquidity(input: Record<string, unknown>): Promise<unknown | unknown[]>;
  closePosition(input: Record<string, unknown>): Promise<unknown>;
}

interface MappedApiPosition {
  positionId: string;
  poolAddress: string;
  tokenXMint: string;
  tokenYMint: string;
  symbolPair: string;
  rangeLowerBin: number;
  rangeUpperBin: number;
  activeBin: number | null;
  currentValueUsd: number;
  feesClaimedUsd: number;
  unrealizedPnlUsd: number;
  ageMinutes: number | null;
  outOfRange: boolean | null;
  openedAt: string | null;
  claimedBaseAmount: number | null;
}

interface TimestampedValue<T> {
  value: T;
  cachedAtMs: number;
}

type ClaimAmountSource = "post_tx" | "cache" | "pnl_estimate" | "unavailable";

export interface MeteoraSdkDlmmGatewayOptions {
  rpcUrl: string;
  walletPrivateKey: string;
  wallet?: string;
  dataApiBaseUrl?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  defaultSlippageBps?: number;
  maxActiveBinDrift?: number;
  now?: () => string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function clampNonNegative(value: number | null): number {
  return value === null ? 0 : Math.max(value, 0);
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function toIsoFromUnixSeconds(value: number | null): string | null {
  if (value === null) {
    return null;
  }
  return new Date(value * 1000).toISOString();
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message.trim().length > 0 ? error.message : fallback;
  }

  const value = String(error).trim();
  return value.length > 0 ? value : fallback;
}

function numberToDecimalString(value: number): string {
  const raw = value.toString();
  if (!/[eE]/.test(raw)) {
    return raw;
  }

  const [coefficientRaw, exponentRaw] = raw.split(/[eE]/);
  const exponent = Number(exponentRaw ?? "0");
  if (!Number.isInteger(exponent)) {
    throw new Error(`Cannot normalize non-integer exponent amount: ${raw}`);
  }

  const coefficient = coefficientRaw ?? raw;
  const negative = coefficient.startsWith("-");
  const normalized = negative ? coefficient.slice(1) : coefficient;
  const [integerPartRaw, fractionPartRaw = ""] = normalized.split(".");
  const digits = `${integerPartRaw ?? "0"}${fractionPartRaw}`;
  const decimalIndex = (integerPartRaw ?? "0").length + exponent;

  let result: string;
  if (decimalIndex <= 0) {
    result = `0.${"0".repeat(Math.abs(decimalIndex))}${digits}`;
  } else if (decimalIndex >= digits.length) {
    result = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  } else {
    result = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  }

  return negative ? `-${result}` : result;
}

function decimalAmountToLamports(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("token amount must be a finite non-negative number");
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("token decimals must be a non-negative integer");
  }

  const normalized = numberToDecimalString(value);
  const [integerPartRaw = "0", fractionPartRaw = ""] = normalized.split(".");
  const integerPart = integerPartRaw.length === 0 ? "0" : integerPartRaw;
  const fractionPart = fractionPartRaw.slice(0, decimals).padEnd(decimals, "0");

  const integerLamports = BigInt(integerPart) * 10n ** BigInt(decimals);
  const fractionLamports =
    fractionPart.length === 0 ? 0n : BigInt(fractionPart);
  return integerLamports + fractionLamports;
}

function decodeWalletPrivateKey(raw: string): Uint8Array {
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error("WALLET_PRIVATE_KEY must not be empty");
  }

  if (value.startsWith("[")) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("WALLET_PRIVATE_KEY JSON array is empty or invalid");
    }
    const decoded = Uint8Array.from(parsed);
    if (decoded.length !== 64) {
      throw new Error("WALLET_PRIVATE_KEY must decode to 64 bytes");
    }
    return decoded;
  }

  const decoded = bs58.decode(value);
  if (decoded.length !== 64) {
    throw new Error("WALLET_PRIVATE_KEY must decode to 64 bytes");
  }
  return decoded;
}

function toStrategyType(
  strategy: string,
  strategyType: MeteoraSdkModule["StrategyType"],
): StrategyTypeValue {
  switch (strategy) {
    case "spot":
      return strategyType.Spot;
    case "curve":
      return strategyType.Curve;
    case "bid_ask":
      return strategyType.BidAsk;
    default:
      throw new Error(`Unsupported Meteora strategy: ${strategy}`);
  }
}

function inferInitialActiveBin(request: DeployLiquidityRequest): number {
  if (
    request.initialActiveBin !== undefined &&
    request.initialActiveBin !== null
  ) {
    return request.initialActiveBin;
  }

  const lower = request.rangeLowerBin;
  const upper = request.rangeUpperBin;
  if (lower !== undefined && upper !== undefined) {
    return Math.round((lower + upper) / 2);
  }

  return 0;
}

function inferRangeLowerBin(request: DeployLiquidityRequest): number {
  if (request.rangeLowerBin === undefined) {
    throw new Error("Meteora native deploy requires rangeLowerBin");
  }
  return request.rangeLowerBin;
}

function inferRangeUpperBin(request: DeployLiquidityRequest): number {
  if (request.rangeUpperBin === undefined) {
    throw new Error("Meteora native deploy requires rangeUpperBin");
  }
  return request.rangeUpperBin;
}

function resolveTokenAmounts(request: DeployLiquidityRequest): {
  amountX: number;
  amountY: number;
} {
  if (
    request.tokenXMint === undefined ||
    request.tokenYMint === undefined ||
    request.baseMint === undefined ||
    request.quoteMint === undefined
  ) {
    throw new Error(
      "Meteora native deploy requires tokenXMint, tokenYMint, baseMint, and quoteMint",
    );
  }

  const amountX =
    request.tokenXMint === request.baseMint
      ? request.amountBase
      : request.tokenXMint === request.quoteMint
        ? request.amountQuote
        : 0;
  const amountY =
    request.tokenYMint === request.baseMint
      ? request.amountBase
      : request.tokenYMint === request.quoteMint
        ? request.amountQuote
        : 0;

  if (amountX <= 0 && amountY <= 0) {
    throw new Error(
      "Meteora native deploy could not map amountBase/amountQuote to tokenX/tokenY mints",
    );
  }

  return { amountX, amountY };
}

export class MeteoraSdkDlmmGateway implements DlmmGateway {
  public readonly reconciliationReadModel = "open_only" as const;
  private readonly connection: Connection;
  private readonly wallet: Keypair;
  private readonly walletAddress: string;
  private readonly dataApiBaseUrl: string;
  private readonly dataApiClient: JsonHttpClient;
  private readonly defaultSlippageBps: number;
  private readonly maxActiveBinDrift: number;
  private readonly now: () => string;
  private sdkModulePromise: Promise<MeteoraSdkModule> | null = null;
  private readonly poolCache = new Map<string, Promise<MeteoraPoolLike>>();
  private readonly decimalsByMint = new Map<string, number>();
  private readonly poolByPositionId = new Map<
    string,
    TimestampedValue<string>
  >();
  private readonly recentDeploys = new Map<
    string,
    TimestampedValue<DeployLiquidityRequest>
  >();
  private readonly claimedBaseByPositionId = new Map<
    string,
    TimestampedValue<number>
  >();
  private openPositionsCache: {
    wallet: string;
    fetchedAtMs: number;
    positions: Position[];
    mapped: MappedApiPosition[];
  } | null = null;

  public constructor(options: MeteoraSdkDlmmGatewayOptions) {
    this.connection = new Connection(options.rpcUrl, "confirmed");
    this.wallet = Keypair.fromSecretKey(
      decodeWalletPrivateKey(options.walletPrivateKey),
    );
    const signerWallet = this.wallet.publicKey.toBase58();
    if (options.wallet !== undefined && options.wallet !== signerWallet) {
      throw new Error("PUBLIC_WALLET_ADDRESS must match WALLET_PRIVATE_KEY");
    }
    this.walletAddress = options.wallet ?? signerWallet;
    this.dataApiBaseUrl = normalizeBaseUrl(
      options.dataApiBaseUrl ?? DefaultDataApiBaseUrl,
    );
    this.dataApiClient = new JsonHttpClient({
      adapterName: "MeteoraDlmmDataApi",
      baseUrl: this.dataApiBaseUrl,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      timeoutMs: options.timeoutMs ?? DefaultDataApiTimeoutMs,
      defaultHeaders: {
        accept: "application/json",
      },
    });
    this.defaultSlippageBps = options.defaultSlippageBps ?? DefaultSlippageBps;
    this.maxActiveBinDrift =
      options.maxActiveBinDrift ?? DefaultMaxActiveBinDrift;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async getPosition(positionId: string): Promise<Position | null> {
    this.pruneEphemeralCaches();
    const parsedPositionId = z.string().min(1).parse(positionId);
    const openPositions = await this.listPositionsForWallet(this.walletAddress);
    const existing = openPositions.positions.find(
      (position) => position.positionId === parsedPositionId,
    );
    if (existing !== undefined) {
      return PositionSchema.parse(existing);
    }

    const recentDeploy = this.recentDeploys.get(parsedPositionId);
    if (recentDeploy !== undefined) {
      return this.buildSyntheticOpenPosition(
        parsedPositionId,
        recentDeploy.value,
      );
    }

    return null;
  }

  public async deployLiquidity(
    request: DeployLiquidityRequest,
  ): Promise<DeployLiquidityResult> {
    this.pruneEphemeralCaches();
    const parsedRequest = DeployLiquidityRequestSchema.parse(request);
    const parsed = parsedRequest.poolAddress;
    const lowerBin = inferRangeLowerBin(request);
    const upperBin = inferRangeUpperBin(request);
    const { amountX, amountY } = resolveTokenAmounts(request);
    const { StrategyType } = await this.sdk();
    const pool = await this.getPool(parsed);
    await this.assertDeployRangeMatchesLiveActiveBin({
      pool,
      lowerBin,
      upperBin,
      initialActiveBin: parsedRequest.initialActiveBin ?? null,
    });
    const strategyType = toStrategyType(parsedRequest.strategy, StrategyType);
    const tokenXLamports = await this.toTokenAmountLamports(
      pool.lbPair.tokenXMint,
      amountX,
    );
    const tokenYLamports = await this.toTokenAmountLamports(
      pool.lbPair.tokenYMint,
      amountY,
    );
    const positionKeypair = Keypair.generate();
    const totalBins = upperBin - lowerBin + 1;
    const txIds: string[] = [];
    const slippageBps = parsedRequest.slippageBps ?? this.defaultSlippageBps;

    if (totalBins > WideRangeBinThreshold) {
      const createTxs = await pool.createExtendedEmptyPosition(
        lowerBin,
        upperBin,
        positionKeypair.publicKey,
        this.wallet.publicKey,
      );
      const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
      for (const [index, tx] of createTxArray.entries()) {
        const signers =
          index === 0 ? [this.wallet, positionKeypair] : [this.wallet];
        txIds.push(await this.sendTransactionWithPreflight(tx, signers));
      }

      const addTxs = await pool.addLiquidityByStrategyChunkable({
        positionPubKey: positionKeypair.publicKey,
        user: this.wallet.publicKey,
        totalXAmount: tokenXLamports,
        totalYAmount: tokenYLamports,
        strategy: {
          minBinId: lowerBin,
          maxBinId: upperBin,
          strategyType,
        },
        slippage: slippageBps,
      });
      const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
      for (const tx of addTxArray) {
        txIds.push(await this.sendTransactionWithPreflight(tx, [this.wallet]));
      }
    } else {
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey,
        user: this.wallet.publicKey,
        totalXAmount: tokenXLamports,
        totalYAmount: tokenYLamports,
        strategy: {
          minBinId: lowerBin,
          maxBinId: upperBin,
          strategyType,
        },
        slippage: slippageBps,
      });
      txIds.push(
        await this.sendTransactionWithPreflight(tx, [
          this.wallet,
          positionKeypair,
        ]),
      );
    }

    const positionId = positionKeypair.publicKey.toBase58();
    this.recentDeploys.set(positionId, {
      value: parsedRequest,
      cachedAtMs: Date.now(),
    });
    this.openPositionsCache = null;
    this.poolByPositionId.set(positionId, {
      value: parsed,
      cachedAtMs: Date.now(),
    });
    return DeployLiquidityResultSchema.parse({
      actionType: "DEPLOY",
      positionId,
      txIds,
    });
  }

  public async closePosition(
    request: ClosePositionRequest,
  ): Promise<ClosePositionResult> {
    this.pruneEphemeralCaches();
    const parsed = ClosePositionRequestSchema.parse(request);
    const poolAddress = await this.lookupPoolAddressForPosition(
      parsed.positionId,
      parsed.wallet,
    );
    const pool = await this.getPool(poolAddress);
    const positionPubkey = new PublicKey(parsed.positionId);
    const claimTxIds: string[] = [];
    const closeTxIds: string[] = [];
    let preCloseFeesClaimed = false;
    let preCloseFeesClaimError: string | null = null;

    try {
      const claimTxs = await pool.claimSwapFee({
        owner: this.wallet.publicKey,
        position: await pool.getPosition(positionPubkey),
      });
      for (const tx of claimTxs) {
        claimTxIds.push(
          await this.sendTransactionWithPreflight(tx, [this.wallet]),
        );
      }
      preCloseFeesClaimed = true;
    } catch (error) {
      preCloseFeesClaimError = errorMessage(
        error,
        "failed to claim fees before close",
      );
    }

    const writeState = await this.loadWritablePositionState(
      pool,
      positionPubkey,
      "close",
    );

    if (writeState.hasLiquidity) {
      const closeTx = await pool.removeLiquidity({
        user: this.wallet.publicKey,
        position: positionPubkey,
        fromBinId: writeState.lowerBin,
        toBinId: writeState.upperBin,
        bps: new BN(FullCloseBps),
        shouldClaimAndClose: !preCloseFeesClaimed,
      });
      for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
        closeTxIds.push(
          await this.sendTransactionWithPreflight(tx, [this.wallet]),
        );
      }
    } else {
      const closeTx = await pool.closePosition({
        owner: this.wallet.publicKey,
        position: { publicKey: positionPubkey },
      });
      closeTxIds.push(
        await this.sendTransactionWithPreflight(closeTx, [this.wallet]),
      );
    }

    this.recentDeploys.delete(parsed.positionId);
    this.claimedBaseByPositionId.delete(parsed.positionId);
    this.poolByPositionId.delete(parsed.positionId);
    this.openPositionsCache = null;
    return ClosePositionResultSchema.parse({
      actionType: "CLOSE",
      closedPositionId: parsed.positionId,
      txIds: [...claimTxIds, ...closeTxIds],
      preCloseFeesClaimed,
      preCloseFeesClaimError,
    });
  }

  public async claimFees(request: ClaimFeesRequest): Promise<ClaimFeesResult> {
    this.pruneEphemeralCaches();
    const parsed = ClaimFeesRequestSchema.parse(request);
    const poolAddress = await this.lookupPoolAddressForPosition(
      parsed.positionId,
      parsed.wallet,
    );
    const pool = await this.getPool(poolAddress);
    const positionPubkey = new PublicKey(parsed.positionId);
    const baseMint =
      parsed.baseMint ??
      (await this.getPosition(parsed.positionId))?.baseMint ??
      pool.lbPair.tokenXMint.toBase58();
    const claimAmountEstimate = await this.estimateClaimedBaseAmount(
      parsed.positionId,
      poolAddress,
      parsed.wallet,
    );
    const claimTxs = await pool.claimSwapFee({
      owner: this.wallet.publicKey,
      position: await pool.getPosition(positionPubkey),
    });

    const txIds: string[] = [];
    for (const tx of claimTxs) {
      txIds.push(await this.sendTransactionWithPreflight(tx, [this.wallet]));
    }
    const postTxClaimedBaseAmount =
      await this.resolveClaimedBaseAmountFromTransactions({
        txIds,
        wallet: parsed.wallet,
        mint: baseMint,
      });
    const claimAmount =
      postTxClaimedBaseAmount === null
        ? claimAmountEstimate
        : {
            amount: postTxClaimedBaseAmount,
            source: "post_tx" as const,
          };

    this.openPositionsCache = null;
    if (claimAmount.source !== "unavailable") {
      this.claimedBaseByPositionId.set(parsed.positionId, {
        value: claimAmount.amount,
        cachedAtMs: Date.now(),
      });
    }
    return ClaimFeesResultSchema.parse({
      actionType: "CLAIM_FEES",
      claimedBaseAmount: claimAmount.amount,
      claimedBaseAmountSource: claimAmount.source,
      txIds,
    });
  }

  public async partialClosePosition(
    request: PartialClosePositionRequest,
  ): Promise<PartialClosePositionResult> {
    this.pruneEphemeralCaches();
    const parsed = PartialClosePositionRequestSchema.parse(request);
    const poolAddress = await this.lookupPoolAddressForPosition(
      parsed.positionId,
      parsed.wallet,
    );
    const pool = await this.getPool(poolAddress);
    const positionPubkey = new PublicKey(parsed.positionId);
    const writeState = await this.loadWritablePositionState(
      pool,
      positionPubkey,
      "partial close",
    );

    const txs = await pool.removeLiquidity({
      user: this.wallet.publicKey,
      position: positionPubkey,
      fromBinId: writeState.lowerBin,
      toBinId: writeState.upperBin,
      bps: new BN(Math.round(parsed.closePercentage * 100)),
      shouldClaimAndClose: false,
    });

    const txIds: string[] = [];
    for (const tx of Array.isArray(txs) ? txs : [txs]) {
      txIds.push(await this.sendTransactionWithPreflight(tx, [this.wallet]));
    }

    this.openPositionsCache = null;
    return PartialClosePositionResultSchema.parse({
      actionType: "PARTIAL_CLOSE",
      closedPositionId: parsed.positionId,
      remainingPercentage: Math.max(0, 100 - parsed.closePercentage),
      txIds,
    });
  }

  public async listPositionsForWallet(
    wallet: string,
  ): Promise<WalletPositionsSnapshot> {
    this.pruneEphemeralCaches();
    const parsedWallet = z.string().min(1).parse(wallet);
    const cache = this.openPositionsCache;
    if (
      cache !== null &&
      cache.wallet === parsedWallet &&
      Date.now() - cache.fetchedAtMs < PositionsCacheTtlMs
    ) {
      return WalletPositionsSnapshotSchema.parse({
        wallet: parsedWallet,
        positions: cache.positions,
      });
    }

    let mappedPositions: MappedApiPosition[];
    try {
      mappedPositions = await this.fetchOpenPositionsFromDataApi(parsedWallet);
    } catch (error) {
      if (
        error instanceof AdapterTransportError ||
        error instanceof AdapterHttpStatusError ||
        error instanceof AdapterResponseValidationError
      ) {
        mappedPositions = await this.fetchOpenPositionsFromSdk(parsedWallet);
      } else {
        throw error;
      }
    }
    if (mappedPositions.length === 0) {
      mappedPositions = await this.fetchOpenPositionsFromSdk(parsedWallet);
    }

    const now = this.now();
    const positions = mappedPositions.map((position) =>
      PositionSchema.parse({
        positionId: position.positionId,
        poolAddress: position.poolAddress,
        tokenXMint: position.tokenXMint,
        tokenYMint: position.tokenYMint,
        baseMint: position.tokenXMint,
        quoteMint: position.tokenYMint,
        wallet: parsedWallet,
        status: "OPEN",
        openedAt: position.openedAt ?? now,
        lastSyncedAt: now,
        closedAt: null,
        deployAmountBase: 0,
        deployAmountQuote: 0,
        currentValueBase: 0,
        currentValueUsd: clampNonNegative(position.currentValueUsd),
        feesClaimedBase: 0,
        feesClaimedUsd: clampNonNegative(position.feesClaimedUsd),
        realizedPnlBase: 0,
        realizedPnlUsd: 0,
        unrealizedPnlBase: 0,
        unrealizedPnlUsd: position.unrealizedPnlUsd,
        rebalanceCount: 0,
        partialCloseCount: 0,
        strategy: "unknown",
        rangeLowerBin: position.rangeLowerBin,
        rangeUpperBin: position.rangeUpperBin,
        activeBin: position.activeBin,
        outOfRangeSince: position.outOfRange === true ? now : null,
        lastManagementDecision: null,
        lastManagementReason: null,
        lastWriteActionId: null,
        needsReconciliation: false,
      }),
    );

    for (const position of positions) {
      this.poolByPositionId.set(position.positionId, {
        value: position.poolAddress,
        cachedAtMs: Date.now(),
      });
    }
    this.openPositionsCache = {
      wallet: parsedWallet,
      fetchedAtMs: Date.now(),
      positions,
      mapped: mappedPositions,
    };

    return WalletPositionsSnapshotSchema.parse({
      wallet: parsedWallet,
      positions,
    });
  }

  public async getPoolInfo(poolAddress: string): Promise<PoolInfo> {
    const parsedPoolAddress = z.string().min(1).parse(poolAddress);
    try {
      const rawPool = asRecord(
        await this.fetchJson(`/pools/${encodeURIComponent(parsedPoolAddress)}`),
      );
      return PoolInfoSchema.parse({
        poolAddress: parsedPoolAddress,
        pairLabel:
          (asString(rawPool.name) ??
            [
              asString(rawPool.tokenX) ?? asString(rawPool.tokenXSymbol),
              asString(rawPool.tokenY) ?? asString(rawPool.tokenYSymbol),
            ]
              .filter((value) => value !== null)
              .join("-")) ||
          parsedPoolAddress,
        binStep:
          asNumber(rawPool.binStep) ??
          asNumber(asRecord(rawPool.dlmmParams).binStep) ??
          1,
        activeBin:
          asNumber(rawPool.activeBinId) ??
          asNumber(rawPool.poolActiveBinId) ??
          0,
      });
    } catch {
      const pool = await this.getPool(parsedPoolAddress);
      const activeBin = await pool.getActiveBin();
      return PoolInfoSchema.parse({
        poolAddress: parsedPoolAddress,
        pairLabel: `${pool.lbPair.tokenXMint.toBase58()}/${pool.lbPair.tokenYMint.toBase58()}`,
        binStep: pool.lbPair.binStep ?? 1,
        activeBin: activeBin.binId,
      });
    }
  }

  private async getPool(poolAddress: string): Promise<MeteoraPoolLike> {
    const cached = this.poolCache.get(poolAddress);
    if (cached !== undefined) {
      return cached;
    }

    const loading = (async () => {
      const sdkModule = await this.sdk();
      return sdkModule.default.create(
        this.connection,
        new PublicKey(poolAddress),
      );
    })();
    this.poolCache.set(poolAddress, loading);
    return loading;
  }

  private async toTokenAmountLamports(
    mint: PublicKey,
    amount: number,
  ): Promise<BN> {
    if (amount <= 0) {
      return new BN(0);
    }

    const decimals = await this.getTokenDecimals(mint);
    return new BN(decimalAmountToLamports(amount, decimals).toString());
  }

  private async fetchJson(path: string): Promise<unknown> {
    return this.dataApiClient.request({
      method: "GET",
      path,
      responseSchema: z.unknown(),
    });
  }

  private async fetchOpenPositionsFromDataApi(
    wallet: string,
  ): Promise<MappedApiPosition[]> {
    const rawPortfolio = asRecord(
      await this.fetchJson(
        `/portfolio/open?user=${encodeURIComponent(wallet)}`,
      ),
    );
    const pools = Array.isArray(rawPortfolio.pools) ? rawPortfolio.pools : [];
    const results: MappedApiPosition[] = [];

    await Promise.all(
      pools.map(async (poolValue) => {
        const pool = asRecord(poolValue);
        const poolAddress =
          asString(pool.poolAddress) ??
          asString(pool.address) ??
          asString(pool.pool) ??
          null;
        if (poolAddress === null) {
          return;
        }

        const pnlByPositionId = await this.fetchPoolPnlByPositionId(
          poolAddress,
          wallet,
        );
        const positionIds = Array.isArray(pool.listPositions)
          ? pool.listPositions
          : [];
        for (const positionValue of positionIds) {
          const positionId = asString(positionValue);
          if (positionId === null) {
            continue;
          }

          const pnl = pnlByPositionId.get(positionId) ?? {};
          const unrealized = asRecord(asRecord(pnl).unrealizedPnl);
          const allTimeFees = asRecord(
            asRecord(asRecord(pnl).allTimeFees).total,
          );
          const symbolPair = [asString(pool.tokenX), asString(pool.tokenY)]
            .filter((value) => value !== null)
            .join("-");
          const activeBin =
            asNumber(asRecord(pnl).poolActiveBinId) ??
            asNumber(pool.activeBinId) ??
            asNumber(pool.poolActiveBinId);
          const lowerBin = asNumber(asRecord(pnl).lowerBinId);
          const upperBin = asNumber(asRecord(pnl).upperBinId);
          results.push({
            positionId,
            poolAddress,
            tokenXMint:
              asString(pool.tokenXMint) ??
              asString(pool.mintX) ??
              `tokenX:${poolAddress}`,
            tokenYMint:
              asString(pool.tokenYMint) ??
              asString(pool.mintY) ??
              `tokenY:${poolAddress}`,
            symbolPair: symbolPair.length > 0 ? symbolPair : poolAddress,
            rangeLowerBin: lowerBin ?? (activeBin ?? 0) - 1,
            rangeUpperBin: upperBin ?? (activeBin ?? 0) + 1,
            activeBin: activeBin ?? null,
            currentValueUsd:
              asNumber(unrealized.balances) ?? asNumber(pool.balances) ?? 0,
            feesClaimedUsd: asNumber(allTimeFees.usd) ?? 0,
            unrealizedPnlUsd:
              asNumber(asRecord(pnl).pnlUsd) ?? asNumber(pool.pnl) ?? 0,
            ageMinutes: (() => {
              const createdAt = asNumber(asRecord(pnl).createdAt);
              if (createdAt === null) {
                return null;
              }
              return Math.max(
                0,
                Math.floor((Date.now() - createdAt * 1000) / 60_000),
              );
            })(),
            outOfRange:
              typeof asRecord(pnl).isOutOfRange === "boolean"
                ? (asRecord(pnl).isOutOfRange as boolean)
                : null,
            openedAt: toIsoFromUnixSeconds(asNumber(asRecord(pnl).createdAt)),
            claimedBaseAmount: this.resolveClaimedBaseAmountFromPnl(
              pnl,
              asString(pool.tokenXMint) ?? asString(pool.mintX) ?? null,
            ),
          });
        }
      }),
    );

    return results;
  }

  private async fetchOpenPositionsFromSdk(
    wallet: string,
  ): Promise<MappedApiPosition[]> {
    const sdkModule = await this.sdk();
    const allPositions = await sdkModule.default.getAllLbPairPositionsByUser(
      this.connection,
      new PublicKey(wallet),
    );

    const results: MappedApiPosition[] = [];
    for (const [poolAddress, poolData] of Object.entries(allPositions)) {
      const pool = await this.getPool(poolAddress);
      const tokenXMint = pool.lbPair.tokenXMint.toBase58();
      const tokenYMint = pool.lbPair.tokenYMint.toBase58();
      const activeBinRecord = await pool.getActiveBin().catch(() => null);
      for (const position of poolData.lbPairPositionsData ?? []) {
        const positionId = position.publicKey.toString();
        const positionSnapshot = await pool
          .getPosition(new PublicKey(positionId))
          .catch((error: unknown) => {
            throw new Error(
              `Meteora SDK could not load position ${positionId}: ${errorMessage(
                error,
                "unknown error",
              )}`,
            );
          });
        results.push({
          positionId,
          poolAddress,
          tokenXMint,
          tokenYMint,
          symbolPair: poolAddress,
          rangeLowerBin: positionSnapshot.positionData?.lowerBinId ?? 0,
          rangeUpperBin: positionSnapshot.positionData?.upperBinId ?? 1,
          activeBin: activeBinRecord?.binId ?? null,
          currentValueUsd: 0,
          feesClaimedUsd: 0,
          unrealizedPnlUsd: 0,
          ageMinutes: null,
          outOfRange: null,
          openedAt: null,
          claimedBaseAmount: null,
        });
      }
    }

    return results;
  }

  private async fetchPoolPnlByPositionId(
    poolAddress: string,
    wallet: string,
  ): Promise<Map<string, Record<string, unknown>>> {
    try {
      const raw = asRecord(
        await this.fetchJson(
          `/positions/${encodeURIComponent(poolAddress)}/pnl?user=${encodeURIComponent(wallet)}&status=open&pageSize=100&page=1`,
        ),
      );
      const positions = Array.isArray(raw.positions)
        ? raw.positions
        : Array.isArray(raw.data)
          ? raw.data
          : [];
      const byPositionId = new Map<string, Record<string, unknown>>();
      for (const value of positions) {
        const record = asRecord(value);
        const positionId =
          asString(record.positionAddress) ??
          asString(record.address) ??
          asString(record.position);
        if (positionId !== null) {
          byPositionId.set(positionId, record);
        }
      }
      return byPositionId;
    } catch {
      return new Map();
    }
  }

  private resolveClaimedBaseAmountFromPnl(
    pnl: Record<string, unknown>,
    tokenXMint: string | null,
  ): number | null {
    const unrealized = asRecord(pnl.unrealizedPnl);
    const tokenX = asRecord(unrealized.unclaimedFeeTokenX);
    const tokenY = asRecord(unrealized.unclaimedFeeTokenY);
    const xMint = asString(tokenX.mint) ?? tokenXMint;
    const yMint = asString(tokenY.mint);
    const readTokenAmount = (record: Record<string, unknown>) =>
      asNumber(record.amount) ??
      asNumber(record.uiAmount) ??
      asNumber(record.amountUi) ??
      asNumber(record.tokenAmount);

    if (xMint !== null && xMint === tokenXMint) {
      return readTokenAmount(tokenX);
    }
    if (yMint !== null && tokenXMint !== null && yMint === tokenXMint) {
      return readTokenAmount(tokenY);
    }
    return readTokenAmount(tokenX);
  }

  private async estimateClaimedBaseAmount(
    positionId: string,
    poolAddress: string,
    wallet: string,
  ): Promise<{
    amount: number;
    source: ClaimAmountSource;
  }> {
    const cached = this.claimedBaseByPositionId.get(positionId);
    if (cached !== undefined) {
      return {
        amount: cached.value,
        source: "cache",
      };
    }

    const cache = this.openPositionsCache;
    if (cache !== null && cache.wallet === wallet) {
      const existing = cache.mapped.find(
        (position) => position.positionId === positionId,
      );
      if (
        existing?.claimedBaseAmount !== null &&
        existing?.claimedBaseAmount !== undefined
      ) {
        return {
          amount: Math.max(existing.claimedBaseAmount, 0),
          source: "pnl_estimate",
        };
      }
    }

    const pnl = (await this.fetchPoolPnlByPositionId(poolAddress, wallet)).get(
      positionId,
    );
    if (pnl !== undefined) {
      const amount = this.resolveClaimedBaseAmountFromPnl(
        pnl,
        asString(asRecord(pnl).tokenXMint),
      );
      if (amount !== null) {
        return {
          amount: Math.max(amount, 0),
          source: "pnl_estimate",
        };
      }
    }

    return {
      amount: 0,
      source: "unavailable",
    };
  }

  private buildSyntheticOpenPosition(
    positionId: string,
    request: DeployLiquidityRequest,
  ): Position {
    const rangeLowerBin = inferRangeLowerBin(request);
    const rangeUpperBin = inferRangeUpperBin(request);
    const activeBin = inferInitialActiveBin(request);
    const now = this.now();

    return PositionSchema.parse({
      positionId,
      poolAddress: request.poolAddress,
      tokenXMint: request.tokenXMint ?? request.baseMint ?? "unknown_token_x",
      tokenYMint: request.tokenYMint ?? request.quoteMint ?? "unknown_token_y",
      baseMint: request.baseMint ?? request.tokenXMint ?? "unknown_base",
      quoteMint: request.quoteMint ?? request.tokenYMint ?? "unknown_quote",
      wallet: request.wallet,
      status: "OPEN",
      openedAt: now,
      lastSyncedAt: now,
      closedAt: null,
      deployAmountBase: request.amountBase,
      deployAmountQuote: request.amountQuote,
      currentValueBase: 0,
      currentValueUsd: 0,
      feesClaimedBase: 0,
      feesClaimedUsd: 0,
      realizedPnlBase: 0,
      realizedPnlUsd: 0,
      unrealizedPnlBase: 0,
      unrealizedPnlUsd: 0,
      rebalanceCount: 0,
      partialCloseCount: 0,
      strategy: request.strategy,
      rangeLowerBin,
      rangeUpperBin,
      activeBin,
      outOfRangeSince: null,
      lastManagementDecision: null,
      lastManagementReason: null,
      lastWriteActionId: null,
      needsReconciliation: false,
    });
  }

  private async lookupPoolAddressForPosition(
    positionId: string,
    wallet: string,
  ): Promise<string> {
    this.pruneEphemeralCaches();
    const cachedPool = this.poolByPositionId.get(positionId);
    if (cachedPool !== undefined) {
      return cachedPool.value;
    }

    const livePositions = await this.listPositionsForWallet(wallet);
    const existing = livePositions.positions.find(
      (position) => position.positionId === positionId,
    );
    if (existing !== undefined) {
      this.poolByPositionId.set(positionId, {
        value: existing.poolAddress,
        cachedAtMs: Date.now(),
      });
      return existing.poolAddress;
    }

    const sdkModule = await this.sdk();
    const allPositions = await sdkModule.default.getAllLbPairPositionsByUser(
      this.connection,
      new PublicKey(wallet),
    );
    for (const [poolAddress, poolData] of Object.entries(allPositions)) {
      const found = (poolData.lbPairPositionsData ?? []).some(
        (position) => position.publicKey.toString() === positionId,
      );
      if (found) {
        this.poolByPositionId.set(positionId, {
          value: poolAddress,
          cachedAtMs: Date.now(),
        });
        return poolAddress;
      }
    }

    throw new Error(
      `Position ${positionId} not found in current Meteora open positions`,
    );
  }

  private async loadWritablePositionState(
    pool: MeteoraPoolLike,
    positionPubkey: PublicKey,
    operation: string,
  ): Promise<{
    lowerBin: number;
    upperBin: number;
    hasLiquidity: boolean;
  }> {
    let positionSnapshot: Awaited<ReturnType<MeteoraPoolLike["getPosition"]>>;
    try {
      positionSnapshot = await pool.getPosition(positionPubkey);
    } catch (error) {
      throw new Error(
        `${operation} requires a readable Meteora position snapshot for ${positionPubkey.toBase58()}: ${errorMessage(
          error,
          "unknown error",
        )}`,
      );
    }

    const lowerBin = positionSnapshot.positionData?.lowerBinId;
    const upperBin = positionSnapshot.positionData?.upperBinId;
    if (lowerBin === undefined || upperBin === undefined) {
      throw new Error(
        `${operation} requires a valid Meteora bin range for ${positionPubkey.toBase58()}`,
      );
    }

    const binData = positionSnapshot.positionData?.positionBinData ?? [];
    const hasLiquidity = binData.some((item) =>
      new BN(item.positionLiquidity ?? 0).gt(new BN(0)),
    );

    return {
      lowerBin,
      upperBin,
      hasLiquidity,
    };
  }

  private async assertDeployRangeMatchesLiveActiveBin(input: {
    pool: MeteoraPoolLike;
    lowerBin: number;
    upperBin: number;
    initialActiveBin: number | null;
  }): Promise<void> {
    const liveActiveBin = (await input.pool.getActiveBin()).binId;
    if (liveActiveBin < input.lowerBin || liveActiveBin > input.upperBin) {
      throw new Error(
        `Refusing deploy: live active bin ${liveActiveBin} outside requested range ${input.lowerBin}-${input.upperBin}`,
      );
    }

    if (input.initialActiveBin === null) {
      return;
    }

    const drift = Math.abs(liveActiveBin - input.initialActiveBin);
    if (drift > this.maxActiveBinDrift) {
      throw new Error(
        `Refusing deploy: active bin drift ${drift} exceeds limit ${this.maxActiveBinDrift}`,
      );
    }
  }

  private async sdk(): Promise<MeteoraSdkModule> {
    if (this.sdkModulePromise === null) {
      this.sdkModulePromise =
        import("@meteora-ag/dlmm") as unknown as Promise<MeteoraSdkModule>;
    }

    return this.sdkModulePromise;
  }

  private async getTokenDecimals(mint: PublicKey): Promise<number> {
    const mintAddress = mint.toBase58();
    const cached = this.decimalsByMint.get(mintAddress);
    if (cached !== undefined) {
      return cached;
    }

    const mintInfo = await this.connection.getParsedAccountInfo(mint);
    if (mintInfo.value === null) {
      throw new Error(`Token mint account not found: ${mintAddress}`);
    }

    const parsedData = asRecord(asRecord(asRecord(mintInfo.value).data).parsed);
    const decimals = asNumber(asRecord(parsedData.info).decimals);
    if (decimals === null) {
      throw new Error(
        `Could not resolve token decimals for mint ${mintAddress}`,
      );
    }

    this.decimalsByMint.set(mintAddress, decimals);
    return decimals;
  }

  private async simulateOrThrow(
    tx: unknown,
    signers: Keypair[],
  ): Promise<void> {
    const connectionWithSimulation = this.connection as Connection & {
      simulateTransaction?: (...args: unknown[]) => Promise<{
        value?: {
          err?: unknown;
          logs?: string[];
        };
      }>;
    };

    if (typeof connectionWithSimulation.simulateTransaction !== "function") {
      return;
    }

    const simulation = await connectionWithSimulation.simulateTransaction(
      tx,
      signers,
    );
    if (simulation.value?.err !== undefined && simulation.value?.err !== null) {
      const logs = Array.isArray(simulation.value.logs)
        ? simulation.value.logs.join(" | ")
        : "";
      throw new Error(
        `Meteora transaction simulation failed${
          logs.length > 0 ? `: ${logs}` : ""
        }`,
      );
    }
  }

  private async sendTransactionWithPreflight(
    tx: unknown,
    signers: Keypair[],
  ): Promise<string> {
    await this.simulateOrThrow(tx, signers);
    let attempt = 0;
    while (true) {
      try {
        return await sendAndConfirmTransaction(
          this.connection,
          tx as never,
          signers,
        );
      } catch (error) {
        const message = errorMessage(error, "transaction send failed");
        const retryDelayMs = RpcSubmitRetryDelaysMs[attempt];
        if (
          retryDelayMs === undefined ||
          !this.isTransientRpcSubmitError(message)
        ) {
          throw error;
        }

        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  private isTransientRpcSubmitError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("blockhash not found") ||
      normalized.includes("not confirmed") ||
      normalized.includes("timed out") ||
      normalized.includes("timeout") ||
      normalized.includes("429") ||
      normalized.includes("too many requests") ||
      normalized.includes("node is behind") ||
      normalized.includes("connection closed") ||
      normalized.includes("temporarily unavailable")
    );
  }

  private pruneEphemeralCaches(): void {
    const nowMs = Date.now();
    const isExpired = (entry: TimestampedValue<unknown>) =>
      nowMs - entry.cachedAtMs > GatewayEntryCacheTtlMs;

    for (const [key, entry] of this.recentDeploys.entries()) {
      if (isExpired(entry)) {
        this.recentDeploys.delete(key);
      }
    }

    for (const [key, entry] of this.poolByPositionId.entries()) {
      if (isExpired(entry)) {
        this.poolByPositionId.delete(key);
      }
    }

    for (const [key, entry] of this.claimedBaseByPositionId.entries()) {
      if (isExpired(entry)) {
        this.claimedBaseByPositionId.delete(key);
      }
    }
  }

  private async resolveClaimedBaseAmountFromTransactions(input: {
    txIds: string[];
    wallet: string;
    mint: string;
  }): Promise<number | null> {
    let total = 0;
    let foundAny = false;
    for (const txId of input.txIds) {
      const amount = await this.resolveClaimedBaseAmountFromTransaction({
        txId,
        wallet: input.wallet,
        mint: input.mint,
      });
      if (amount !== null) {
        total += amount;
        foundAny = true;
      }
    }

    return foundAny ? Math.max(total, 0) : null;
  }

  private async resolveClaimedBaseAmountFromTransaction(input: {
    txId: string;
    wallet: string;
    mint: string;
  }): Promise<number | null> {
    const connectionWithParsedTx = this.connection as Connection & {
      getParsedTransaction?: (...args: unknown[]) => Promise<unknown>;
    };
    if (typeof connectionWithParsedTx.getParsedTransaction !== "function") {
      return null;
    }

    let transaction: unknown;
    try {
      transaction = await connectionWithParsedTx.getParsedTransaction(
        input.txId,
        {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        },
      );
    } catch {
      return null;
    }

    const meta = asRecord(asRecord(transaction).meta);
    const preBalances = Array.isArray(meta.preTokenBalances)
      ? meta.preTokenBalances
      : [];
    const postBalances = Array.isArray(meta.postTokenBalances)
      ? meta.postTokenBalances
      : [];
    const preByAccount = this.sumTokenBalancesByAccount(preBalances, input);
    const postByAccount = this.sumTokenBalancesByAccount(postBalances, input);
    const accountIndexes = new Set([
      ...preByAccount.keys(),
      ...postByAccount.keys(),
    ]);
    let delta = 0;
    for (const accountIndex of accountIndexes) {
      delta +=
        (postByAccount.get(accountIndex) ?? 0) -
        (preByAccount.get(accountIndex) ?? 0);
    }

    return delta > 0 ? delta : null;
  }

  private sumTokenBalancesByAccount(
    balances: unknown[],
    input: {
      wallet: string;
      mint: string;
    },
  ): Map<string, number> {
    const result = new Map<string, number>();
    for (const value of balances) {
      const record = asRecord(value);
      const owner = asString(record.owner);
      const mint = asString(record.mint);
      if (owner !== input.wallet || mint !== input.mint) {
        continue;
      }

      const accountIndex = String(record.accountIndex ?? result.size);
      const amount = this.readUiTokenAmount(asRecord(record.uiTokenAmount));
      if (amount !== null) {
        result.set(accountIndex, amount);
      }
    }

    return result;
  }

  private readUiTokenAmount(
    uiTokenAmount: Record<string, unknown>,
  ): number | null {
    const directAmount =
      asNumber(uiTokenAmount.uiAmount) ??
      asNumber(uiTokenAmount.uiAmountString);
    if (directAmount !== null) {
      return directAmount;
    }

    const rawAmount = asNumber(uiTokenAmount.amount);
    const decimals = asNumber(uiTokenAmount.decimals);
    if (
      rawAmount !== null &&
      decimals !== null &&
      Number.isInteger(decimals) &&
      decimals >= 0
    ) {
      return rawAmount / 10 ** decimals;
    }

    return null;
  }
}
