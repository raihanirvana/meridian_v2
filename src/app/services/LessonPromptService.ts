import {
  defaultLessonCaps,
  formatLessonsPrompt,
  selectLessonsForRole,
} from "../../domain/rules/lessonPromptRules.js";
import { type LessonRole } from "../../domain/types/enums.js";

import { type LessonRepositoryInterface } from "../../adapters/storage/LessonRepository.js";

export interface BuildLessonsPromptInput {
  role: LessonRole;
  maxLessons?: number;
}

export interface LessonPromptService {
  buildLessonsPrompt(input: BuildLessonsPromptInput): Promise<string | null>;
}

export class DefaultLessonPromptService implements LessonPromptService {
  public constructor(
    private readonly lessonRepository: LessonRepositoryInterface,
  ) {}

  public async buildLessonsPrompt(
    input: BuildLessonsPromptInput,
  ): Promise<string | null> {
    const lessons = await this.lessonRepository.list();
    if (lessons.length === 0) {
      return null;
    }

    const sections = selectLessonsForRole({
      lessons,
      role: input.role,
      caps: defaultLessonCaps(input.role !== "GENERAL", input.maxLessons),
      now: new Date().toISOString(),
    });
    const prompt = formatLessonsPrompt(sections);
    return prompt.trim().length > 0 ? prompt : null;
  }
}
