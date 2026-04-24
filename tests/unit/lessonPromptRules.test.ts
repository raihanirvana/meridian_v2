import { describe, expect, it } from "vitest";

import {
  formatLessonsPrompt,
  selectLessonsForRole,
} from "../../src/domain/rules/lessonPromptRules.js";
import { type Lesson } from "../../src/domain/entities/Lesson.js";

function buildLesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    id: "lesson_001",
    rule: "Avoid thin pools after sharp volume collapse",
    tags: ["volume_collapse"],
    outcome: "bad",
    role: null,
    pinned: false,
    createdAt: "2026-04-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("lesson prompt rules", () => {
  it("selects lessons in pinned -> role -> recent order without duplicates", () => {
    const sections = selectLessonsForRole({
      lessons: [
        buildLesson({ id: "pinned", pinned: true, tags: ["efficient"] }),
        buildLesson({ id: "role", role: "SCREENER", tags: ["worked"] }),
        buildLesson({ id: "recent", tags: [] }),
      ],
      role: "SCREENER",
      caps: {
        pinnedCap: 5,
        roleCap: 6,
        recentCap: 10,
      },
      now: "2026-04-22T00:00:00.000Z",
    });

    expect(sections.pinned.map((lesson) => lesson.id)).toEqual(["pinned"]);
    expect(sections.role.map((lesson) => lesson.id)).toEqual(["role"]);
    expect(sections.recent.map((lesson) => lesson.id)).toEqual(["recent"]);
  });

  it("formats lessons prompt with section headers", () => {
    const prompt = formatLessonsPrompt({
      pinned: [buildLesson({ id: "pinned", pinned: true })],
      role: [buildLesson({ id: "role", role: "SCREENER" })],
      recent: [buildLesson({ id: "recent" })],
      roleLabel: "SCREENER",
    });

    expect(prompt).toContain("── PINNED (1) ──");
    expect(prompt).toContain("── SCREENER (1) ──");
    expect(prompt).toContain("── RECENT (1) ──");
  });
});
