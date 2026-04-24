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
  ): Promise<CandidateRankingResult> {
    const parsedInput = CandidateRankingInputSchema.parse(input);
    const payload = await this.complete({
      model: this.resolveModel("screening"),
      systemPrompt: [
        parsedInput.systemPrompt,
        jsonInstruction("CandidateRankingResult"),
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
  ): Promise<ManagementExplanationResult> {
    const parsedInput = ManagementExplanationInputSchema.parse(input);
    const payload = await this.complete({
      model: this.resolveModel("management"),
      systemPrompt: [
        parsedInput.systemPrompt,
        jsonInstruction("ManagementExplanationResult"),
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
}
