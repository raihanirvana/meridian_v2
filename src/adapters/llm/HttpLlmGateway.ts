import { z } from "zod";

import {
  AdapterResponseValidationError,
  JsonHttpClient,
  type FetchLike,
} from "../http/HttpJsonClient.js";
import {
  CandidateRankingInputSchema,
  CandidateRankingResultSchema,
  ManagementExplanationInputSchema,
  ManagementExplanationResultSchema,
  type CandidateRankingInput,
  type CandidateRankingResult,
  type LlmGateway,
  type ManagementExplanationInput,
  type ManagementExplanationResult,
} from "./LlmGateway.js";
import {
  AiRebalanceDecisionSchema,
  RebalanceReviewInputSchema,
  type AiRebalanceDecision,
  type RebalanceReviewInput,
} from "../../domain/entities/RebalanceDecision.js";

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

export interface HttpLlmGatewayOptions {
  baseUrl: string;
  apiKey?: string;
  generalModel?: string;
  managementModel?: string;
  screeningModel?: string;
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
    const objectStart = candidate.indexOf("{");
    const objectEnd = candidate.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      return JSON.parse(candidate.slice(objectStart, objectEnd + 1));
    }
    throw new Error("LLM response is not valid JSON");
  }
}

function jsonInstruction(schemaName: string): string {
  return [
    "Return JSON only.",
    `The JSON must match the expected ${schemaName} shape exactly.`,
    "Do not include markdown fences or extra commentary.",
  ].join(" ");
}

const CANDIDATE_RANKING_RESULT_CONTRACT = [
  "CandidateRankingResult JSON contract:",
  "- rankedCandidateIds: array of candidateId strings.",
  "- reasoning: non-empty concise string.",
  "rankedCandidateIds must include every input candidateId exactly once.",
  "Do not add extra keys such as rankedCandidates, candidates, score, notes, markdown, or commentary.",
  'Valid example: {"rankedCandidateIds":["cand_a","cand_b"],"reasoning":"cand_a has better liquidity quality and lower risk."}',
].join("\n");

const MANAGEMENT_EXPLANATION_RESULT_CONTRACT = [
  "ManagementExplanationResult JSON contract:",
  "- action: one of HOLD, CLAIM_FEES, PARTIAL_CLOSE, REBALANCE, CLOSE, RECONCILE_ONLY.",
  "- reasoning: non-empty concise string.",
  "The action should normally match the proposedAction unless the prompt explicitly asks for a different safe explanation.",
  "Do not add extra keys such as reason, notes, markdown, or commentary.",
  'Valid example: {"action":"CLAIM_FEES","reasoning":"Fees exceed the configured claim threshold while position risk remains acceptable."}',
].join("\n");

const AI_REBALANCE_DECISION_CONTRACT = [
  "AiRebalanceDecision JSON contract:",
  "- action: one of hold, claim_only, rebalance_same_pool, exit.",
  "- confidence: number from 0 to 1.",
  "- riskLevel: one of low, medium, high.",
  "- reason: array of strings.",
  "- rebalancePlan: object or null.",
  "- rejectIf: array of strings.",
  "rebalancePlan object fields, when action is rebalance_same_pool:",
  "- strategy: one of spot, curve, bid_ask.",
  "- binsBelow: non-negative integer.",
  "- binsAbove: non-negative integer.",
  "- slippageBps: non-negative integer.",
  "- maxPositionAgeMinutes: non-negative integer.",
  "- stopLossPct: non-negative number.",
  "- takeProfitPct: non-negative number.",
  "- trailingStopPct: non-negative number.",
  "If action is rebalance_same_pool, rebalancePlan must be present.",
  "If action is not rebalance_same_pool, rebalancePlan must be null.",
  "Do not add extra keys such as reasoning, plan, strategy, notes, markdown, or commentary.",
  'Valid hold example: {"action":"hold","confidence":0.71,"riskLevel":"medium","reason":["Position is still manageable but confidence is below rebalance threshold."],"rebalancePlan":null,"rejectIf":["active bin drifts further"]}',
  'Valid rebalance example: {"action":"rebalance_same_pool","confidence":0.82,"riskLevel":"medium","reason":["Position is out of range and pool depth remains adequate."],"rebalancePlan":{"strategy":"spot","binsBelow":60,"binsAbove":20,"slippageBps":250,"maxPositionAgeMinutes":720,"stopLossPct":5,"takeProfitPct":10,"trailingStopPct":2},"rejectIf":["simulation fails","active bin drifts more than allowed"]}',
].join("\n");

export class HttpLlmGateway implements LlmGateway {
  private readonly client: JsonHttpClient;
  private readonly generalModel: string | null;
  private readonly managementModel: string | null;
  private readonly screeningModel: string | null;

  public constructor(options: HttpLlmGatewayOptions) {
    this.client = new JsonHttpClient({
      adapterName: "HttpLlmGateway",
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
    this.generalModel = options.generalModel ?? null;
    this.managementModel = options.managementModel ?? null;
    this.screeningModel = options.screeningModel ?? null;
  }

  private resolveModel(kind: "management" | "screening"): string {
    const model =
      kind === "management"
        ? (this.managementModel ?? this.generalModel)
        : (this.screeningModel ?? this.generalModel);

    if (model === null) {
      throw new AdapterResponseValidationError("HttpLlmGateway", [
        `no ${kind} model configured`,
      ]);
    }

    return model;
  }

  private async complete(input: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    signal?: AbortSignal;
  }): Promise<unknown> {
    const response = await this.client.request({
      method: "POST",
      path: "/chat/completions",
      body: {
        model: input.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: input.systemPrompt,
          },
          {
            role: "user",
            content: input.userPrompt,
          },
        ],
      },
      responseSchema: ChatCompletionResponseSchema,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    const content = normalizeMessageContent(
      response.choices[0]?.message?.content,
    );
    if (content === null) {
      throw new AdapterResponseValidationError("HttpLlmGateway", [
        "LLM response did not include textual message content",
      ]);
    }

    try {
      return extractJsonPayload(content);
    } catch (error) {
      throw new AdapterResponseValidationError("HttpLlmGateway", [
        error instanceof Error
          ? error.message
          : "LLM response is not valid JSON",
      ]);
    }
  }

  public async rankCandidates(
    input: CandidateRankingInput,
    options?: { signal?: AbortSignal },
  ): Promise<CandidateRankingResult> {
    const parsedInput = CandidateRankingInputSchema.parse(input);
    const payload = await this.complete({
      model: this.resolveModel("screening"),
      systemPrompt: [
        parsedInput.systemPrompt,
        jsonInstruction("CandidateRankingResult"),
        CANDIDATE_RANKING_RESULT_CONTRACT,
      ]
        .filter((part): part is string => part !== null)
        .join("\n\n"),
      userPrompt: [
        "Re-rank the shortlist without dropping or duplicating candidates.",
        "Return rankedCandidateIds in best-to-worst order and one concise reasoning string.",
        JSON.stringify(
          parsedInput.candidates.map((candidate) => ({
            candidateId: candidate.candidateId,
            symbolPair: candidate.symbolPair,
            score: candidate.score,
            decisionReason: candidate.decisionReason,
            scoreBreakdown: candidate.scoreBreakdown,
          })),
        ),
      ].join("\n\n"),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    const parsed = CandidateRankingResultSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AdapterResponseValidationError("HttpLlmGateway", [
        ...parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
      ]);
    }

    return parsed.data;
  }

  public async explainManagementDecision(
    input: ManagementExplanationInput,
    options?: { signal?: AbortSignal },
  ): Promise<ManagementExplanationResult> {
    const parsedInput = ManagementExplanationInputSchema.parse(input);
    const payload = await this.complete({
      model: this.resolveModel("management"),
      systemPrompt: [
        parsedInput.systemPrompt,
        jsonInstruction("ManagementExplanationResult"),
        MANAGEMENT_EXPLANATION_RESULT_CONTRACT,
      ]
        .filter((part): part is string => part !== null)
        .join("\n\n"),
      userPrompt: [
        "Explain the deterministic management proposal and return one action plus one concise reasoning string.",
        JSON.stringify({
          positionId: parsedInput.positionId,
          proposedAction: parsedInput.proposedAction,
          triggerReasons: parsedInput.triggerReasons,
          positionSnapshot: parsedInput.positionSnapshot,
        }),
      ].join("\n\n"),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    const parsed = ManagementExplanationResultSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AdapterResponseValidationError("HttpLlmGateway", [
        ...parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
      ]);
    }

    return parsed.data;
  }

  public async reviewRebalanceDecision(
    input: RebalanceReviewInput,
    options?: { signal?: AbortSignal },
  ): Promise<AiRebalanceDecision> {
    const parsedInput = RebalanceReviewInputSchema.parse(input);
    const payload = await this.complete({
      model: this.resolveModel("management"),
      systemPrompt: [
        "You are a Meteora DLMM rebalance risk analyst.",
        "Prioritize capital preservation over fee chasing.",
        "Allowed actions: hold, claim_only, rebalance_same_pool, exit.",
        "Do not recommend rebalance if pool risk is high; recommend exit instead.",
        "Do not recommend bid_ask unless volume is strong, depth is sufficient, and volatility is mean-reverting.",
        "Use curve only when volatility is low and price is likely to remain near active bin.",
        "Use spot for moderate volatility or uncertain but still healthy conditions.",
        "If confidence is below 0.75, action must be hold or exit.",
        "If action is not rebalance_same_pool, rebalancePlan must be null.",
        jsonInstruction("AiRebalanceDecision"),
        AI_REBALANCE_DECISION_CONTRACT,
      ].join("\n"),
      userPrompt: JSON.stringify(parsedInput),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    const parsed = AiRebalanceDecisionSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AdapterResponseValidationError("HttpLlmGateway", [
        ...parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
      ]);
    }

    return parsed.data;
  }
}
