import { type Lesson } from "../entities/Lesson.js";
import { type LessonRole } from "../types/enums.js";

export const ROLE_TAGS: Record<LessonRole, string[]> = {
  SCREENER: ["efficient", "worked", "volume_collapse"],
  MANAGER: ["oor", "failed", "efficient", "worked"],
  GENERAL: [],
};

const OUTCOME_PRIORITY: Record<Lesson["outcome"], number> = {
  bad: 0,
  poor: 1,
  manual: 1,
  evolution: 2,
  good: 2,
};

export interface LessonPromptCaps {
  pinnedCap: number;
  roleCap: number;
  recentCap: number;
}

export interface SelectedLessonsForRole {
  pinned: Lesson[];
  role: Lesson[];
  recent: Lesson[];
  roleLabel: LessonRole;
}

function byOutcomePriority(left: Lesson, right: Lesson): number {
  const delta =
    OUTCOME_PRIORITY[left.outcome] - OUTCOME_PRIORITY[right.outcome];
  if (delta !== 0) {
    return delta;
  }

  return right.createdAt.localeCompare(left.createdAt);
}

export function defaultLessonCaps(
  isAutoCycle: boolean,
  maxLessons?: number,
): LessonPromptCaps {
  return {
    pinnedCap: isAutoCycle ? 5 : 10,
    roleCap: isAutoCycle ? 6 : 15,
    recentCap: maxLessons ?? (isAutoCycle ? 10 : 35),
  };
}

export function selectLessonsForRole(input: {
  lessons: Lesson[];
  role: LessonRole;
  caps: LessonPromptCaps;
  now: string;
}): SelectedLessonsForRole {
  const usedIds = new Set<string>();
  const roleTags = ROLE_TAGS[input.role] ?? [];

  const pinned = input.lessons
    .filter(
      (lesson) =>
        lesson.pinned &&
        (lesson.role === null ||
          lesson.role === input.role ||
          input.role === "GENERAL"),
    )
    .sort(byOutcomePriority)
    .slice(0, input.caps.pinnedCap);
  for (const lesson of pinned) {
    usedIds.add(lesson.id);
  }

  const roleMatched = input.lessons
    .filter((lesson) => {
      if (usedIds.has(lesson.id)) {
        return false;
      }

      const roleAllowed =
        lesson.role === null ||
        lesson.role === input.role ||
        input.role === "GENERAL";
      const tagAllowed =
        roleTags.length === 0 ||
        lesson.tags.some((tag) => roleTags.includes(tag));

      return roleAllowed && tagAllowed;
    })
    .sort(byOutcomePriority)
    .slice(0, input.caps.roleCap);
  for (const lesson of roleMatched) {
    usedIds.add(lesson.id);
  }

  const remaining = Math.max(
    input.caps.recentCap - pinned.length - roleMatched.length,
    0,
  );
  const recent =
    remaining > 0
      ? input.lessons
          .filter((lesson) => !usedIds.has(lesson.id))
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, remaining)
      : [];

  return {
    pinned,
    role: roleMatched,
    recent,
    roleLabel: input.role,
  };
}

function formatTimestampForPrompt(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatLessonLine(lesson: Lesson): string {
  const pinnedPrefix = lesson.pinned ? "\uD83D\uDCCC " : "";
  const metadata = [
    lesson.pool === undefined ? null : `pool=${lesson.pool}`,
    lesson.role === null ? null : `role=${lesson.role}`,
    lesson.tags.length === 0 ? null : `tags=${lesson.tags.join(",")}`,
    lesson.pnlPct === undefined ? null : `pnl=${formatPercent(lesson.pnlPct)}`,
    lesson.rangeEfficiencyPct === undefined
      ? null
      : `range_efficiency=${formatPercent(lesson.rangeEfficiencyPct)}`,
    lesson.context === undefined ? null : `context=${lesson.context}`,
  ].filter((item): item is string => item !== null);
  const metadataSuffix =
    metadata.length === 0 ? "" : ` | ${metadata.join("; ")}`;

  return `${pinnedPrefix}[${lesson.outcome.toUpperCase()}] [${formatTimestampForPrompt(lesson.createdAt)}] ${lesson.rule}${metadataSuffix}`;
}

export function formatLessonsPrompt(sections: SelectedLessonsForRole): string {
  const blocks: string[] = [];

  if (sections.pinned.length > 0) {
    blocks.push(
      [
        `── PINNED (${sections.pinned.length}) ──`,
        ...sections.pinned.map(formatLessonLine),
      ].join("\n"),
    );
  }

  if (sections.role.length > 0) {
    blocks.push(
      [
        `── ${sections.roleLabel} (${sections.role.length}) ──`,
        ...sections.role.map(formatLessonLine),
      ].join("\n"),
    );
  }

  if (sections.recent.length > 0) {
    blocks.push(
      [
        `── RECENT (${sections.recent.length}) ──`,
        ...sections.recent.map(formatLessonLine),
      ].join("\n"),
    );
  }

  return blocks.join("\n\n");
}
