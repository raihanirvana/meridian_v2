import { z } from "zod";

import {
  CandidateRankingInputSchema,
  CandidateRankingResultSchema,
  ManagementExplanationInputSchema,
  ManagementExplanationResultSchema,
  type LlmGateway,
} from "../../adapters/llm/LlmGateway.js";
import {
  CandidateSchema,
  type Candidate,
} from "../../domain/entities/Candidate.js";
import { type Position } from "../../domain/entities/Position.js";
import {
  ManagementEvaluationResultSchema,
  type ManagementEvaluationResult,
} from "../../domain/rules/managementRules.js";
import { ManagementActionSchema } from "../../domain/types/enums.js";
import {
  AiModeSchema,
  type UserConfig,
} from "../../infra/config/configSchema.js";
import { logger } from "../../infra/logging/logger.js";
import { type LessonPromptService } from "./LessonPromptService.js";

const AdvisorySourceSchema = z.enum([
  "DISABLED",
  "DETERMINISTIC",
  "AI",
  "FALLBACK",
]);

export type AiMode = UserConfig["ai"]["mode"];
export type AdvisorySource = z.infer<typeof AdvisorySourceSchema>;

export const RankedShortlistWithAiSchema = z
  .object({
    shortlist: CandidateSchema.array(),
    source: AdvisorySourceSchema,
    aiReasoning: z.string().min(1).nullable(),
  })
  .strict();

export const ManagementDecisionAdvisorySchema = z
  .object({
    source: AdvisorySourceSchema,
    aiSuggestedAction: ManagementActionSchema.nullable(),
    aiReasoning: z.string().min(1).nullable(),
  })
  .strict();

export type RankedShortlistWithAi = z.infer<typeof RankedShortlistWithAiSchema>;
export type ManagementDecisionAdvisory = z.infer<
  typeof ManagementDecisionAdvisorySchema
>;

export interface RankShortlistWithAiInput {
  shortlist: Candidate[];
  aiMode: AiMode;
  lessonPromptService: LessonPromptService;
  llmGateway?: LlmGateway;
  timeoutMs?: number;
}

export interface AdviseManagementDecisionInput {
  aiMode: AiMode;
  evaluation: ManagementEvaluationResult;
  position: Position;
  triggerReasons: string[];
  lessonPromptService: LessonPromptService;
  llmGateway?: LlmGateway;
  timeoutMs?: number;
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`AI advisory timed out after ${timeoutMs}ms`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(timeoutError(timeoutMs));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function shouldUseAi(
  mode: AiMode,
  llmGateway: LlmGateway | undefined,
): boolean {
  return mode !== "disabled" && llmGateway !== undefined;
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  return timeoutMs ?? 250;
}

function reorderShortlist(
  shortlist: Candidate[],
  rankedCandidateIds: string[],
): Candidate[] | null {
  const candidateIds = shortlist.map((candidate) => candidate.candidateId);
  if (rankedCandidateIds.length !== shortlist.length) {
    return null;
  }

  const uniqueIds = new Set(rankedCandidateIds);
  if (uniqueIds.size !== rankedCandidateIds.length) {
    return null;
  }

  const expectedIds = new Set(candidateIds);
  if (expectedIds.size !== rankedCandidateIds.length) {
    return null;
  }

  const byId = new Map(
    shortlist.map((candidate) => [candidate.candidateId, candidate] as const),
  );

  const ordered: Candidate[] = [];
  for (const candidateId of rankedCandidateIds) {
    const candidate = byId.get(candidateId);
    if (candidate === undefined) {
      return null;
    }

    ordered.push(candidate);
  }

  if (rankedCandidateIds.some((candidateId) => !expectedIds.has(candidateId))) {
    return null;
  }

  return ordered;
}

function logAiFallback(message: string, error: unknown): void {
  logger.warn(
    {
      err: error,
    },
    message,
  );
}

function logLessonInjectionFailure(error: unknown): void {
  logger.warn(
    {
      err: error,
    },
    "ai_lesson_injection_failed",
  );
}

export async function rankShortlistWithAi(
  input: RankShortlistWithAiInput,
): Promise<RankedShortlistWithAi> {
  const shortlist = CandidateSchema.array().parse(input.shortlist);
  const aiMode = AiModeSchema.parse(input.aiMode);
  const llmGateway = input.llmGateway;

  if (shortlist.length <= 1) {
    return RankedShortlistWithAiSchema.parse({
      shortlist,
      source: "DETERMINISTIC",
      aiReasoning: null,
    });
  }

  if (!shouldUseAi(aiMode, llmGateway)) {
    return RankedShortlistWithAiSchema.parse({
      shortlist,
      source: aiMode === "disabled" ? "DISABLED" : "DETERMINISTIC",
      aiReasoning: null,
    });
  }

  if (llmGateway === undefined) {
    return RankedShortlistWithAiSchema.parse({
      shortlist,
      source: "DETERMINISTIC",
      aiReasoning: null,
    });
  }

  let lessonsPrompt: string | null;
  try {
    lessonsPrompt = await input.lessonPromptService.buildLessonsPrompt({
      role: "SCREENER",
      includePoolMemory: {
        candidates: shortlist.map((candidate) => ({
          poolAddress: candidate.poolAddress,
        })),
      },
    });
  } catch (error) {
    logLessonInjectionFailure(error);
    return RankedShortlistWithAiSchema.parse({
      shortlist,
      source: "FALLBACK",
      aiReasoning: null,
    });
  }

  try {
    const ranking = CandidateRankingResultSchema.parse(
      await withTimeout(
        llmGateway.rankCandidates(
          CandidateRankingInputSchema.parse({
            candidates: shortlist,
            systemPrompt:
              lessonsPrompt === null
                ? null
                : `### LESSONS LEARNED\n${lessonsPrompt}`,
          }),
        ),
        normalizeTimeout(input.timeoutMs),
      ),
    );
    const rankedShortlist = reorderShortlist(
      shortlist,
      ranking.rankedCandidateIds,
    );

    if (rankedShortlist === null) {
      throw new Error(
        "AI ranking response did not cover the shortlist exactly",
      );
    }

    return RankedShortlistWithAiSchema.parse({
      shortlist: rankedShortlist,
      source: "AI",
      aiReasoning: ranking.reasoning,
    });
  } catch (error) {
    logAiFallback(
      "AI shortlist ranking fallback to deterministic order",
      error,
    );
    return RankedShortlistWithAiSchema.parse({
      shortlist,
      source: "FALLBACK",
      aiReasoning: null,
    });
  }
}

export async function adviseManagementDecision(
  input: AdviseManagementDecisionInput,
): Promise<ManagementDecisionAdvisory> {
  const aiMode = AiModeSchema.parse(input.aiMode);
  const evaluation = ManagementEvaluationResultSchema.parse(input.evaluation);
  const llmGateway = input.llmGateway;

  if (!shouldUseAi(aiMode, llmGateway)) {
    return ManagementDecisionAdvisorySchema.parse({
      source: aiMode === "disabled" ? "DISABLED" : "DETERMINISTIC",
      aiSuggestedAction: null,
      aiReasoning: null,
    });
  }

  if (llmGateway === undefined) {
    return ManagementDecisionAdvisorySchema.parse({
      source: "DETERMINISTIC",
      aiSuggestedAction: null,
      aiReasoning: null,
    });
  }

  let lessonsPrompt: string | null;
  try {
    lessonsPrompt = await input.lessonPromptService.buildLessonsPrompt({
      role: "MANAGER",
    });
  } catch (error) {
    logLessonInjectionFailure(error);
    return ManagementDecisionAdvisorySchema.parse({
      source: "FALLBACK",
      aiSuggestedAction: null,
      aiReasoning: null,
    });
  }

  try {
    const explanation = ManagementExplanationResultSchema.parse(
      await withTimeout(
        llmGateway.explainManagementDecision(
          ManagementExplanationInputSchema.parse({
            positionId: input.position.positionId,
            proposedAction: evaluation.action,
            positionSnapshot: input.position,
            triggerReasons: input.triggerReasons,
            systemPrompt:
              lessonsPrompt === null
                ? null
                : `### LESSONS LEARNED\n${lessonsPrompt}`,
          }),
        ),
        normalizeTimeout(input.timeoutMs),
      ),
    );

    return ManagementDecisionAdvisorySchema.parse({
      source: "AI",
      aiSuggestedAction: explanation.action,
      aiReasoning: explanation.reasoning,
    });
  } catch (error) {
    logAiFallback(
      "AI management explanation fallback to deterministic result",
      error,
    );
    return ManagementDecisionAdvisorySchema.parse({
      source: "FALLBACK",
      aiSuggestedAction: null,
      aiReasoning: null,
    });
  }
}
