import { z } from "zod";

import {
  AmbiguousSubmissionError,
  ClaimFeesResultSchema,
  ClosePositionResultSchema,
  DeployLiquidityResultSchema,
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
} from "../../adapters/dlmm/DlmmGateway.js";
import {
  SolPriceQuoteSchema,
  type PriceGateway,
  type SolPriceQuote,
} from "../../adapters/pricing/PriceGateway.js";
import {
  WalletBalanceSnapshotSchema,
  type WalletBalanceSnapshot,
  type WalletGateway,
} from "../../adapters/wallet/WalletGateway.js";
import { ActionSchema } from "../../domain/entities/Action.js";
import { JournalEventSchema } from "../../domain/entities/JournalEvent.js";
import {
  PositionSchema,
  type Position,
} from "../../domain/entities/Position.js";
import {
  ManagementSignalsSchema,
  type ManagementSignals,
} from "../../domain/rules/managementRules.js";

const ReplayFailureSchema = z.object({
  type: z.literal("fail"),
  error: z.string().min(1),
});

const ReplayTimeoutSchema = z.object({
  type: z.literal("timeout"),
  timeoutMs: z.number().int().positive().optional(),
});

const ReplayAmbiguousSchema = z.object({
  type: z.literal("ambiguous"),
  operation: z.enum(["DEPLOY", "CLOSE", "CLAIM_FEES"]),
  positionId: z.string().min(1),
  txIds: z.array(z.string().min(1)).default([]),
  timeoutMs: z.number().int().positive().optional(),
});

function buildReplaySuccessSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.object({
    type: z.literal("success"),
    value: valueSchema,
  });
}

const DeployReplaySchema = z.discriminatedUnion("type", [
  buildReplaySuccessSchema(DeployLiquidityResultSchema),
  ReplayFailureSchema,
  ReplayTimeoutSchema,
  ReplayAmbiguousSchema,
]);

const CloseReplaySchema = z.discriminatedUnion("type", [
  buildReplaySuccessSchema(ClosePositionResultSchema),
  ReplayFailureSchema,
  ReplayTimeoutSchema,
  ReplayAmbiguousSchema,
]);

const ClaimFeesReplaySchema = z.discriminatedUnion("type", [
  buildReplaySuccessSchema(ClaimFeesResultSchema),
  ReplayFailureSchema,
  ReplayTimeoutSchema,
  ReplayAmbiguousSchema,
]);

const PartialCloseReplaySchema = z.discriminatedUnion("type", [
  buildReplaySuccessSchema(PartialClosePositionResultSchema),
  ReplayFailureSchema,
  ReplayTimeoutSchema,
]);

export const ReplaySimulationStepSchema = z.object({
  timestamp: z.string().datetime(),
  walletBalanceSol: z.number().nonnegative(),
  solPriceUsd: z.number().positive(),
  onChainPositions: z.array(PositionSchema),
  signalsByPositionId: z
    .record(z.string(), ManagementSignalsSchema)
    .default({}),
});

export const ReplaySimulationFixtureSchema = z
  .object({
    wallet: z.string().min(1),
    initialPositions: z.array(PositionSchema).default([]),
    initialActions: z.array(ActionSchema).default([]),
    initialJournalEvents: z.array(JournalEventSchema).default([]),
    steps: z.array(ReplaySimulationStepSchema).min(1),
    deployResponses: z.array(DeployReplaySchema).default([]),
    closeResponses: z.array(CloseReplaySchema).default([]),
    claimFeesResponses: z.array(ClaimFeesReplaySchema).default([]),
    partialCloseResponses: z.array(PartialCloseReplaySchema).default([]),
    poolInfoByPool: z.record(z.string(), PoolInfoSchema).default({}),
  })
  .strict()
  .superRefine((fixture, ctx) => {
    let previousTimestampMs: number | null = null;

    for (const [index, step] of fixture.steps.entries()) {
      const currentTimestampMs = Date.parse(step.timestamp);
      if (Number.isNaN(currentTimestampMs)) {
        continue;
      }

      if (
        previousTimestampMs !== null &&
        currentTimestampMs < previousTimestampMs
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "timestamp"],
          message: "must be monotonic across replay steps",
        });
        return;
      }

      previousTimestampMs = currentTimestampMs;
    }
  });

export type ReplaySimulationStep = z.infer<typeof ReplaySimulationStepSchema>;
export type ReplaySimulationFixture = z.infer<
  typeof ReplaySimulationFixtureSchema
>;

type ReplaySuccess<T> = {
  type: "success";
  value: T;
};

type ReplayFailure = z.infer<typeof ReplayFailureSchema>;
type ReplayTimeout = z.infer<typeof ReplayTimeoutSchema>;
type ReplayAmbiguous = z.infer<typeof ReplayAmbiguousSchema>;
type ReplayResult<T> =
  | ReplaySuccess<T>
  | ReplayFailure
  | ReplayTimeout
  | ReplayAmbiguous;

async function resolveReplayResult<T>(entry: ReplayResult<T>): Promise<T> {
  if (entry.type === "success") {
    return entry.value;
  }

  if (entry.type === "fail") {
    throw new Error(entry.error);
  }

  if (entry.type === "ambiguous") {
    throw new AmbiguousSubmissionError(
      `Replay ambiguous submission for ${entry.operation} after ${entry.timeoutMs ?? 10}ms`,
      {
        operation: entry.operation,
        positionId: entry.positionId,
        txIds: entry.txIds,
      },
    );
  }

  const timeoutMs = entry.timeoutMs ?? 10;
  throw new Error(`Replay timeout after ${timeoutMs}ms`);
}

function defaultSignals(): ManagementSignals {
  return {
    forcedManualClose: false,
    severeTokenRisk: false,
    liquidityCollapse: false,
    severeNegativeYield: false,
    claimableFeesUsd: 0,
    expectedRebalanceImprovement: false,
    dataIncomplete: false,
  };
}

export class ReplaySimulationGateway
  implements DlmmGateway, PriceGateway, WalletGateway
{
  private readonly fixture: ReplaySimulationFixture;
  private readonly deployResponses: ReplayResult<DeployLiquidityResult>[];
  private readonly closeResponses: ReplayResult<ClosePositionResult>[];
  private readonly claimFeesResponses: ReplayResult<ClaimFeesResult>[];
  private readonly partialCloseResponses: ReplayResult<PartialClosePositionResult>[];
  private currentStepIndex = 0;
  private generatedDeployCount = 0;
  private generatedCloseCount = 0;

  public constructor(rawFixture: ReplaySimulationFixture) {
    this.fixture = ReplaySimulationFixtureSchema.parse(rawFixture);
    this.deployResponses = [...this.fixture.deployResponses];
    this.closeResponses = [...this.fixture.closeResponses];
    this.claimFeesResponses = [...this.fixture.claimFeesResponses];
    this.partialCloseResponses = [...this.fixture.partialCloseResponses];
  }

  public useStep(stepIndex: number): ReplaySimulationStep {
    if (stepIndex < 0 || stepIndex >= this.fixture.steps.length) {
      throw new Error(`Replay step ${stepIndex} is out of bounds`);
    }

    this.currentStepIndex = stepIndex;
    return this.currentStep;
  }

  public getSignal(positionId: string): ManagementSignals {
    const signal = this.currentStep.signalsByPositionId[positionId];
    if (signal === undefined) {
      return defaultSignals();
    }

    return ManagementSignalsSchema.parse(signal);
  }

  public getStepCount(): number {
    return this.fixture.steps.length;
  }

  public getFixture(): ReplaySimulationFixture {
    return this.fixture;
  }

  public async getPosition(positionId: string): Promise<Position | null> {
    const found =
      this.currentStep.onChainPositions.find(
        (position) => position.positionId === positionId,
      ) ?? null;
    return found === null ? null : PositionSchema.parse(found);
  }

  public async deployLiquidity(
    _request: DeployLiquidityRequest,
  ): Promise<DeployLiquidityResult> {
    const replay =
      this.deployResponses.shift() ??
      ({
        type: "success",
        value: {
          actionType: "DEPLOY",
          positionId: `sim_deploy_${this.generatedDeployCount + 1}`,
          txIds: [`tx_deploy_${this.generatedDeployCount + 1}`],
          submissionStatus: "submitted",
        },
      } satisfies ReplaySuccess<DeployLiquidityResult>);
    const result = await resolveReplayResult(replay);
    this.generatedDeployCount += 1;

    return DeployLiquidityResultSchema.parse({
      ...result,
      ...(result.positionId.trim().length > 0
        ? {}
        : { positionId: `sim_deploy_${this.generatedDeployCount}` }),
      actionType: "DEPLOY",
      txIds:
        result.txIds.length > 0
          ? result.txIds
          : [`tx_deploy_${this.generatedDeployCount}`],
    });
  }

  public async closePosition(
    request: ClosePositionRequest,
  ): Promise<ClosePositionResult> {
    const parsedRequest = request;
    const replay =
      this.closeResponses.shift() ??
      ({
        type: "success",
        value: {
          actionType: "CLOSE",
          closedPositionId: parsedRequest.positionId,
          txIds: [`tx_close_${this.generatedCloseCount + 1}`],
          submissionStatus: "submitted",
        },
      } satisfies ReplaySuccess<ClosePositionResult>);
    const result = await resolveReplayResult(replay);
    this.generatedCloseCount += 1;

    return ClosePositionResultSchema.parse({
      ...result,
      actionType: "CLOSE",
      closedPositionId:
        result.closedPositionId.trim().length > 0
          ? result.closedPositionId
          : parsedRequest.positionId,
      txIds:
        result.txIds.length > 0
          ? result.txIds
          : [`tx_close_${this.generatedCloseCount}`],
    });
  }

  public async claimFees(_request: ClaimFeesRequest): Promise<ClaimFeesResult> {
    const replay =
      this.claimFeesResponses.shift() ??
      ({
        type: "success",
        value: {
          actionType: "CLAIM_FEES",
          claimedBaseAmount: 0,
          txIds: ["tx_claim_1"],
          submissionStatus: "submitted",
        },
      } satisfies ReplaySuccess<ClaimFeesResult>);
    return ClaimFeesResultSchema.parse(await resolveReplayResult(replay));
  }

  public async partialClosePosition(
    request: PartialClosePositionRequest,
  ): Promise<PartialClosePositionResult> {
    const replay =
      this.partialCloseResponses.shift() ??
      ({
        type: "success",
        value: {
          actionType: "PARTIAL_CLOSE",
          closedPositionId: request.positionId,
          remainingPercentage: 50,
          txIds: ["tx_partial_close_1"],
        },
      } satisfies ReplaySuccess<PartialClosePositionResult>);
    return PartialClosePositionResultSchema.parse(
      await resolveReplayResult(replay),
    );
  }

  public async simulateDeployLiquidity() {
    return { ok: true, reason: null };
  }

  public async simulateClosePosition() {
    return { ok: true, reason: null };
  }

  public async listPositionsForWallet(
    wallet: string,
  ): Promise<WalletPositionsSnapshot> {
    return WalletPositionsSnapshotSchema.parse({
      wallet,
      positions: this.currentStep.onChainPositions.filter(
        (position) => position.wallet === wallet,
      ),
    });
  }

  public async getPoolInfo(poolAddress: string): Promise<PoolInfo> {
    const configuredPool = this.fixture.poolInfoByPool[poolAddress];
    if (configuredPool !== undefined) {
      return PoolInfoSchema.parse(configuredPool);
    }

    const matchingPosition = this.currentStep.onChainPositions.find(
      (position) => position.poolAddress === poolAddress,
    );

    return PoolInfoSchema.parse({
      poolAddress,
      pairLabel:
        matchingPosition === undefined
          ? poolAddress
          : `${matchingPosition.baseMint}/${matchingPosition.quoteMint}`,
      binStep: 1,
      activeBin: matchingPosition?.activeBin ?? 0,
    });
  }

  public async getSolPriceUsd(): Promise<SolPriceQuote> {
    return SolPriceQuoteSchema.parse({
      symbol: "SOL",
      priceUsd: this.currentStep.solPriceUsd,
      asOf: this.currentStep.timestamp,
    });
  }

  public async getWalletBalance(
    wallet: string,
  ): Promise<WalletBalanceSnapshot> {
    return WalletBalanceSnapshotSchema.parse({
      wallet,
      balanceSol: this.currentStep.walletBalanceSol,
      asOf: this.currentStep.timestamp,
    });
  }

  private get currentStep(): ReplaySimulationStep {
    const step = this.fixture.steps[this.currentStepIndex];
    if (step === undefined) {
      throw new Error(`Replay step ${this.currentStepIndex} is not available`);
    }

    return step;
  }
}

export function createReplayFailure(error: string): ReplayFailure {
  return ReplayFailureSchema.parse({
    type: "fail",
    error,
  });
}

export function createReplayTimeout(timeoutMs?: number): ReplayTimeout {
  return ReplayTimeoutSchema.parse({
    type: "timeout",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

export function createReplaySuccess<T>(value: T): ReplaySuccess<T> {
  return {
    type: "success",
    value,
  };
}
