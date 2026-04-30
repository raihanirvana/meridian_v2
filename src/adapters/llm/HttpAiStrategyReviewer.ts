import { z } from "zod";

import {
  AdapterResponseValidationError,
  JsonHttpClient,
  type FetchLike,
} from "../http/HttpJsonClient.js";
import {
  AiStrategyBatchReviewInputSchema,
  AiStrategyReviewInputSchema,
  StrategyReviewBatchResultSchema,
  StrategyReviewResultSchema,
  type AiStrategyBatchReviewInput,
  type AiStrategyReviewInput,
  type AiStrategyReviewer,
  type StrategyReviewResult,
} from "./AiStrategyReviewer.js";

const ChatMessageSchema = z
  .object({
    content: z
      .union([
        z.string(),
        z.array(
          z
            .object({
              type: z.string(),
              text: z.string().optional(),
            })
            .passthrough(),
        ),
      ])
      .nullable()
      .optional(),
  })
  .passthrough();

const ChatCompletionResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: ChatMessageSchema,
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export interface HttpAiStrategyReviewerOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

function normalizeMessageContent(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }

      const textValue =
        "text" in part && typeof part.text === "string" ? part.text : null;
      return textValue === null ? [] : [textValue];
    })
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

function extractJsonPayload(input: string): unknown {
  const trimmed = input.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const arrayStart = candidate.indexOf("[");
    const arrayEnd = candidate.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      return JSON.parse(candidate.slice(arrayStart, arrayEnd + 1));
    }

    const objectStart = candidate.indexOf("{");
    const objectEnd = candidate.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      return JSON.parse(candidate.slice(objectStart, objectEnd + 1));
    }
    throw new Error("LLM response is not valid JSON");
  }
}

function buildSystemContent(systemPrompt: string | null): string {
  return [
    systemPrompt,
    "Return JSON only. No markdown fences, no commentary.",
    "",
    "ROLE",
    "You are the deploy-strategy reviewer for a live Meteora DLMM bot. Deterministic filters have already vetted these candidates for hard safety. Your job is to MAKE A DECISION, not to add another conservative gate.",
    "",
    "DEFAULT POSTURE",
    "Default to deploy when the candidate's data is fresh, depth supports the configured position size, and a strategy maps cleanly to the volatility/trend profile.",
    "Use 'watch' only when ONE specific deploy-critical signal is missing or contradictory (named, not generic).",
    "Use 'reject' only for concrete non-deployable risk that the deterministic filters should have caught but hasn't (e.g. obvious depeg, mint authority active, near-zero depth).",
    "If you would otherwise output 'watch' with confidence >= the configured minimum AND a concrete recommendedStrategy, switch to 'deploy'.",
    "",
    "WALLET RISK MODE",
    "botContext.walletRiskMode signals desired aggression:",
    "- 'aggressive_memecoin': prioritize fee capture, accept higher token risk if depth and freshness are OK, lean into bid_ask for high-vol mean-reverting pairs and spot for moderate-vol moonshot setups.",
    "- 'small' or 'conservative': bias toward curve/spot, tighter slippage, higher confidence bar for bid_ask.",
    "- default: balanced.",
    "",
    "STRATEGY MAPPING (concrete rules)",
    "- curve: pick when volatility1hPct < 4 AND trendStrength1h < 40 AND meanReversionScore > 50. Best for stables/correlated pairs and quiet majors.",
    "- spot: pick when 4 <= volatility1hPct <= 10 OR you cannot confidently classify the regime but liquidity quality is good. Default safe choice for unknown directional pairs.",
    "- bid_ask: pick when volatility1hPct > 8 AND meanReversionScore > 55 AND depth supports it. AVOID bid_ask if priceChange15mPct or priceChange1hPct shows one-way trend (>15% / >25% absolute).",
    "",
    "DATA INTERPRETATION",
    "Use screeningSnapshot for aggregate volume, fee-to-TVL, organic score, and age. marketFeatureSnapshot windowed fields can legitimately be 0 because the upstream omits granular windows.",
    "Do NOT claim zero-volume when screeningSnapshot proves activity. Describe missing granular windows as 'lacks granular confirmation', not 'no activity'.",
    "Treat zero/null pool age, token age, and smart money as WEAK signals (informational), not blockers, unless other fields show concrete risk.",
    "If botContext.requireTokenIntelForDeploy is false, missing token intelligence is informational only; missing tokenIntelFetchedAt must not drive watch/reject by itself.",
    "",
    "RANGE & SLIPPAGE SIZING",
    "Pick binsBelow and binsAbove based on volatility:",
    "- low vol (curve): 15-25 each side",
    "- moderate vol (spot): 25-40 each side",
    "- high vol (bid_ask): 40-60 each side, with slight bias toward direction the meanReversionScore implies oscillation around",
    "- For aggressive_memecoin: skew up by 10-15 bins each side because memecoin volatility undershoots in 1h windows.",
    "Total bins per position must stay <= 60 to fit within Meteora's 69-bin position cap with safety margin.",
    "Slippage: 200-300 for stable/curve, 300-500 for spot, 500-700 for bid_ask on volatile memecoins. Never exceed botContext.maxSlippageBps.",
    "",
    "EXIT PARAMETERS (required when decision=deploy)",
    "stopLossPct: 5-10 for aggressive memecoin (higher tolerance), 3-5 for stable. Must be > 0.",
    "takeProfitPct: 1.5-2x stopLossPct. Must be > 0.",
    "trailingStopPct: 2-4 for memecoin, 1-2 for stable. Must be > 0.",
    "maxPositionAgeMinutes: 360-720 for memecoin (capture multi-leg pumps), 1440 for stable.",
    "",
    "AVOID THESE FAILURE MODES",
    "Do not output 'watch' with no specific named blocker; that is the exact behavior we are correcting.",
    "Do not deploy on stale snapshots, depth_near_active_too_shallow, missing active bin, or one_way_price_move strategy mismatch.",
    "Do not optimize purely for fee-to-TVL ratio: a 10% ratio with $300 TVL is noise, not opportunity.",
    "Do not recommend bid_ask in trending markets just because volatility is high.",
    "",
    "You produce only the recommendation JSON. The action queue and validator decide execution.",
  ]
    .filter((part): part is string => part !== null)
    .join("\n");
}

const STRATEGY_REVIEW_RESULT_CONTRACT = [
  "StrategyReviewResult JSON contract:",
  "- poolAddress: string, copied exactly from the candidate.",
  "- decision: one of deploy, watch, reject.",
  "- recommendedStrategy: one of curve, spot, bid_ask, none.",
  "- confidence: number from 0 to 1.",
  "- riskLevel: one of low, medium, high.",
  "- binsBelow: non-negative integer.",
  "- binsAbove: non-negative integer.",
  "- slippageBps: non-negative integer.",
  "- maxPositionAgeMinutes: non-negative integer.",
  "- stopLossPct: non-negative number.",
  "- takeProfitPct: non-negative number.",
  "- trailingStopPct: non-negative number.",
  "- reasons: array of strings.",
  "- rejectIf: array of strings.",
  "If decision is deploy, recommendedStrategy must not be none.",
  "If decision is reject, recommendedStrategy must be none.",
  "Do not add extra keys such as strategy, reason, notes, markdown, or commentary.",
  "Valid deploy example:",
  '{"poolAddress":"POOL_ADDRESS","decision":"deploy","recommendedStrategy":"curve","confidence":0.72,"riskLevel":"medium","binsBelow":60,"binsAbove":20,"slippageBps":300,"maxPositionAgeMinutes":720,"stopLossPct":5,"takeProfitPct":10,"trailingStopPct":2,"reasons":["fresh active bin","adequate depth","curve strategy fit"],"rejectIf":["active bin drifts more than allowed"]}',
  "Valid watch example:",
  '{"poolAddress":"POOL_ADDRESS","decision":"watch","recommendedStrategy":"spot","confidence":0.62,"riskLevel":"medium","binsBelow":60,"binsAbove":20,"slippageBps":300,"maxPositionAgeMinutes":720,"stopLossPct":5,"takeProfitPct":10,"trailingStopPct":2,"reasons":["needs stronger recent fee confirmation"],"rejectIf":["volume remains weak"]}',
].join("\n");

function buildDataFreshnessPayload(input: AiStrategyReviewInput) {
  const freshness = input.candidate.dataFreshnessSnapshot;
  if (input.botContext?.requireTokenIntelForDeploy !== false) {
    return freshness;
  }

  return {
    ...freshness,
    tokenIntelFetchedAt: "not_required",
    tokenIntelRequiredForDeploy: false,
  };
}

function buildCandidatePayload(input: AiStrategyReviewInput) {
  return {
    poolAddress: input.candidate.poolAddress,
    symbolPair: input.candidate.symbolPair,
    score: input.candidate.score,
    scoreBreakdown: input.candidate.scoreBreakdown,
    screeningSnapshot: input.candidate.screeningSnapshot,
    marketFeatureSnapshot: input.candidate.marketFeatureSnapshot,
    dlmmMicrostructureSnapshot: input.candidate.dlmmMicrostructureSnapshot,
    tokenRiskSnapshot: input.candidate.tokenRiskSnapshot,
    smartMoneySnapshot: input.candidate.smartMoneySnapshot,
    dataFreshnessSnapshot: buildDataFreshnessPayload(input),
    strategySuitability: input.candidate.strategySuitability,
  };
}

export class HttpAiStrategyReviewer implements AiStrategyReviewer {
  private readonly client: JsonHttpClient;
  private readonly model: string;

  public constructor(options: HttpAiStrategyReviewerOptions) {
    this.client = new JsonHttpClient({
      adapterName: "HttpAiStrategyReviewer",
      baseUrl: options.baseUrl,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      defaultHeaders:
        options.apiKey === undefined
          ? {}
          : { authorization: `Bearer ${options.apiKey}` },
    });
    this.model = options.model;
  }

  public async reviewCandidateStrategy(
    input: AiStrategyReviewInput,
  ): Promise<StrategyReviewResult> {
    const parsedInput = AiStrategyReviewInputSchema.parse(input);
    const response = await this.client.request({
      method: "POST",
      path: "/chat/completions",
      body: {
        model: this.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `${buildSystemContent(parsedInput.systemPrompt)}\n\n${STRATEGY_REVIEW_RESULT_CONTRACT}\n\nReturn one StrategyReviewResult JSON object exactly.`,
          },
          {
            role: "user",
            content: JSON.stringify({
              botContext: parsedInput.botContext ?? null,
              candidate: buildCandidatePayload(parsedInput),
            }),
          },
        ],
      },
      responseSchema: ChatCompletionResponseSchema,
    });
    const content = normalizeMessageContent(
      response.choices[0]?.message?.content,
    );
    if (content === null) {
      throw new AdapterResponseValidationError("HttpAiStrategyReviewer", [
        "LLM response did not include textual message content",
      ]);
    }

    let payload: unknown;
    try {
      payload = extractJsonPayload(content);
    } catch (error) {
      throw new AdapterResponseValidationError("HttpAiStrategyReviewer", [
        error instanceof Error
          ? error.message
          : "LLM response is not valid JSON",
      ]);
    }

    const parsed = StrategyReviewResultSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AdapterResponseValidationError("HttpAiStrategyReviewer", [
        ...parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
      ]);
    }

    return parsed.data;
  }

  public async reviewCandidateStrategies(
    input: AiStrategyBatchReviewInput,
  ): Promise<StrategyReviewResult[]> {
    const parsedInput = AiStrategyBatchReviewInputSchema.parse(input);
    const response = await this.client.request({
      method: "POST",
      path: "/chat/completions",
      body: {
        model: this.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `${buildSystemContent(parsedInput.systemPrompt)}\n\n${STRATEGY_REVIEW_RESULT_CONTRACT}\n\nReturn one JSON array. Each item must match StrategyReviewResult exactly. Include exactly one item for every candidate poolAddress.`,
          },
          {
            role: "user",
            content: JSON.stringify({
              botContext: parsedInput.botContext ?? null,
              candidates: parsedInput.candidates.map((candidate) =>
                buildCandidatePayload({
                  candidate,
                  systemPrompt: parsedInput.systemPrompt,
                  ...(parsedInput.botContext === undefined
                    ? {}
                    : { botContext: parsedInput.botContext }),
                }),
              ),
            }),
          },
        ],
      },
      responseSchema: ChatCompletionResponseSchema,
    });
    const content = normalizeMessageContent(
      response.choices[0]?.message?.content,
    );
    if (content === null) {
      throw new AdapterResponseValidationError("HttpAiStrategyReviewer", [
        "LLM response did not include textual message content",
      ]);
    }

    let payload: unknown;
    try {
      payload = extractJsonPayload(content);
    } catch (error) {
      throw new AdapterResponseValidationError("HttpAiStrategyReviewer", [
        error instanceof Error
          ? error.message
          : "LLM response is not valid JSON",
      ]);
    }

    const parsed = StrategyReviewBatchResultSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AdapterResponseValidationError("HttpAiStrategyReviewer", [
        ...parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
      ]);
    }

    return parsed.data;
  }
}
