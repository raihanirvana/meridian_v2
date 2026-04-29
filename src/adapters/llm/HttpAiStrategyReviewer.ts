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
    "Return JSON only. No markdown fences. Capital preservation is more important than yield.",
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
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
  "Valid item example:",
  '{"poolAddress":"POOL_ADDRESS","decision":"watch","recommendedStrategy":"spot","confidence":0.72,"riskLevel":"medium","binsBelow":60,"binsAbove":20,"slippageBps":300,"maxPositionAgeMinutes":720,"stopLossPct":5,"takeProfitPct":10,"trailingStopPct":2,"reasons":["fresh active bin","moderate volatility"],"rejectIf":["active bin drifts more than allowed"]}',
].join("\n");

function buildCandidatePayload(input: AiStrategyReviewInput) {
  return {
    poolAddress: input.candidate.poolAddress,
    symbolPair: input.candidate.symbolPair,
    score: input.candidate.score,
    scoreBreakdown: input.candidate.scoreBreakdown,
    marketFeatureSnapshot: input.candidate.marketFeatureSnapshot,
    dlmmMicrostructureSnapshot: input.candidate.dlmmMicrostructureSnapshot,
    tokenRiskSnapshot: input.candidate.tokenRiskSnapshot,
    smartMoneySnapshot: input.candidate.smartMoneySnapshot,
    dataFreshnessSnapshot: input.candidate.dataFreshnessSnapshot,
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
