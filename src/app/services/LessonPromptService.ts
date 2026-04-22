import {
  defaultLessonCaps,
  formatLessonsPrompt,
  selectLessonsForRole,
} from "../../domain/rules/lessonPromptRules.js";
import { buildPoolRecallString } from "../../domain/rules/poolMemoryRules.js";
import { type LessonRole } from "../../domain/types/enums.js";

import { type LessonRepositoryInterface } from "../../adapters/storage/LessonRepository.js";
import { type PoolMemoryRepository } from "../../adapters/storage/PoolMemoryRepository.js";

export interface BuildLessonsPromptInput {
  role: LessonRole;
  maxLessons?: number;
  includePoolMemory?: {
    candidates: Array<{
      poolAddress: string;
    }>;
  };
}

export interface LessonPromptService {
  buildLessonsPrompt(input: BuildLessonsPromptInput): Promise<string | null>;
}

export class DefaultLessonPromptService implements LessonPromptService {
  public constructor(
    private readonly lessonRepository: LessonRepositoryInterface,
    private readonly poolMemoryRepository?: PoolMemoryRepository,
  ) {}

  public async buildLessonsPrompt(
    input: BuildLessonsPromptInput,
  ): Promise<string | null> {
    const lessons = await this.lessonRepository.list();
    const blocks: string[] = [];

    if (lessons.length > 0) {
      const sections = selectLessonsForRole({
        lessons,
        role: input.role,
        caps: defaultLessonCaps(input.role !== "GENERAL", input.maxLessons),
        now: new Date().toISOString(),
      });
      const lessonPrompt = formatLessonsPrompt(sections).trim();
      if (lessonPrompt.length > 0) {
        blocks.push(lessonPrompt);
      }
    }

    if (input.includePoolMemory !== undefined) {
      if (this.poolMemoryRepository === undefined) {
        throw new Error(
          "PoolMemoryRepository is required when includePoolMemory is requested",
        );
      }

      const uniquePoolAddresses = [...new Set(
        input.includePoolMemory.candidates.map((candidate) => candidate.poolAddress),
      )];
      const recalls = (
        await Promise.all(
          uniquePoolAddresses.map(async (poolAddress) => {
            const entry = await this.poolMemoryRepository?.get(poolAddress);
            if (entry === null || entry === undefined) {
              return null;
            }

            const recall = buildPoolRecallString(entry);
            if (recall === null) {
              return null;
            }

            return `- ${poolAddress}: ${recall}`;
          }),
        )
      ).filter((recall): recall is string => recall !== null);

      if (recalls.length > 0) {
        blocks.push([
          "### POOL MEMORY",
          ...recalls,
        ].join("\n"));
      }
    }

    const prompt = blocks.join("\n\n").trim();
    return prompt.length > 0 ? prompt : null;
  }
}
