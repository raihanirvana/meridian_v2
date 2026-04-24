import { z } from "zod";

import {
  AdapterResponseValidationError,
  JsonHttpClient,
  type FetchLike,
} from "../http/HttpJsonClient.js";
import {
  AiStrategyReviewInputSchema,
  StrategyReviewResultSchema,
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
    const objectStart = candidate.indexOf("{");
    const objectEnd = candidate.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      return JSON.parse(candidate.slice(objectStart, objectEnd + 1));
    }
    throw new Error("LLM response is not valid JSON");
  }
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
            content: [
              parsedInput.systemPrompt,
              "Return JSON only. Match StrategyReviewResult exactly. No markdown fences.",
            ]
              .filter((part): part is string => part !== null)
              .join("\n\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              poolAddress: parsedInput.candidate.poolAddress,
              symbolPair: parsedInput.candidate.symbolPair,
              score: parsedInput.candidate.score,
              scoreBreakdown: parsedInput.candidate.scoreBreakdown,
              marketFeatureSnapshot:
                parsedInput.candidate.marketFeatureSnapshot,
              dlmmMicrostructureSnapshot:
                parsedInput.candidate.dlmmMicrostructureSnapshot,
              tokenRiskSnapshot: parsedInput.candidate.tokenRiskSnapshot,
              smartMoneySnapshot: parsedInput.candidate.smartMoneySnapshot,
              dataFreshnessSnapshot:
                parsedInput.candidate.dataFreshnessSnapshot,
              strategySuitability: parsedInput.candidate.strategySuitability,
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
}
