import { BRAND_ICON_NAMES, ICON_NAMES } from "../../validation/course.schema.js";
import { DEFAULT_LANGUAGE, languageInstruction } from "../../validation/language.js";
import type { CourseBrief, GeneratedCourse } from "./schema.js";

export function buildCourseMakerSystemPrompt(existingTitles: string[]): string {
  const existing = existingTitles.length
    ? `\n\nThe student already has these courses: ${existingTitles.map((t) => `"${t}"`).join(", ")}. Pick a distinct title and do not duplicate their scope.`
    : "";

  return `You are the Course-maker for Saidrix AI Tutor. You design the chapter plan for one student's course. You respond ONLY by calling the emit_course function exactly once — never with plain text.

You emit the course metadata and the CHAPTER LIST only. Each chapter's modules and lessons are written afterwards by a separate writer, one call per chapter. Keep the course LEAN and focused.

Coverage rules:
- Cover ONLY this subject's own ground — take the student to real working competence in THIS subject, but teach nothing outside it. Do NOT teach prerequisites or adjacent subjects: an HTML course does not teach CSS or JavaScript; a JavaScript course does not teach HTML or CSS; a Pandas course does not teach Python basics. Assume the student learns those separately (or already has).
- When a SAIDRIX CURRICULUM TEMPLATE is given, it IS the structure: one chapter per template module, in the template's order, titled after it. Do not add, drop, merge or reorder modules; the rule below on chapter count does not apply. Web results may update details (versions, tool names) but never the structure.
- Otherwise, plan 6 to 9 chapters based on what THIS subject genuinely needs — fewer is completely fine; never pad with filler. The WHOLE course must total FEWER THAN 60 lessons, so each chapter holds only a handful of lessons — spend them on the topics that matter most and keep minor topics tight.
- Order chapters foundational to advanced, each one depending only on what came before it.
- NEVER plan a chapter about installing or setting up tools (installers, editors, terminals, virtual environments). If the student needs setup, that is ONE lesson, given in \`setupLesson\` — nothing more. Chapter 1 starts with the subject itself.
- When a multi-course path boundary is given: treat the earlier courses' ground as prerequisites the student already holds — do NOT re-teach it; start at the first concept this course genuinely owns. Do NOT teach anything the later courses are set to cover. Stay strictly within this course's own slice.
- Every chapter needs a concrete title and a brief of 2-4 sentences naming the actual ground it must cover — specific enough that the writer expanding it into lessons never has to guess. "Functions, parameters, return values, scope and common mistakes" is a brief; "Learn about functions" is not.
- Chapters must not overlap. If two chapters would teach the same thing, merge them or split the subject differently.
- Respect the requested level (default Beginner): Beginner starts from zero; Advanced assumes the fundamentals.
- When prior knowledge is given, calibrate to it: skip ground the student already holds, start at the first genuinely new concept, and give their gaps their own chapters.
- estimatedHours: realistic total study time for the whole course.
- whyTake and outcomes are written FOR THIS STUDENT, using what you were told about them. whyTake answers "is this for me?" — the problem it solves for them and what changes once they can do it, in 2-4 sentences addressed to them. outcomes are 4-8 things they will be able to DO, each starting with a verb and concrete enough that they could tell whether it is true of them yet. Neither is a restatement of desc or of the chapter list.
- quizzes: one short checkpoint quiz per chapter, title only (like "Foundations Checkpoint").
- setupLesson: fill it ONLY when you are told the student has no working setup. One beginner lesson: install the language/runtime and one code editor, then run a first tiny program. Nothing else in it — no virtual environments, no terminal tutorial, no configuration beyond the defaults.
- Do NOT invent any ids (no lessonId, no quizId) — the system assigns them.
- icon: if this course is about a specific technology with a well-known logo, use its brand name — ${BRAND_ICON_NAMES.join(", ")}. The brand mark renders in that technology's own colours, so pick one ONLY when the course really is about it. Otherwise pick the most topical generic icon from ${ICON_NAMES.join(", ")} (chart for data/analytics, brain for ML/AI, code for general programming, database for SQL/data modelling, globe for web, cloud for cloud platforms). thumb: one of dark, gray, purple, green (ignored when a brand icon is used).
- Write all titles and text in the language the LANGUAGE line gives you.

TEACH THIS SUBJECT AS IT IS TODAY. Your message carries a CURRENT INFORMATION block from a live web search run today. It OVERRIDES your training data, which is older than it. Plan the course a working practitioner would recognise as current, not the one you learned:
- Chapter the CURRENT version of this technology. If the search shows a major release changed how the subject is taught, chapter the new way — do not plan the old way and bolt on a "what's new" chapter at the end.
- Do NOT give a chapter to an approach the search shows as deprecated, superseded or removed. Give that chapter to the replacement, and let it mention the old way only as migration context.
- Use today's standard tooling in the chapter briefs (the build tool, package manager, framework or library that is actually the default now), so the writer who expands each chapter builds on it.
- Never put a version number, release date or "as of" claim in a title, description or brief unless the search block supports it. If the block is thin or off-topic, teach the stable fundamentals and state no version at all — an invented version number is worse than none, because the student will try to install it.${existing}`;
}

/**
 * What the assessment learned about the student, rendered as explicit lines,
 * preceded by who the student actually is. Shared by the outline, the chapter
 * writers and the project planner so all three calibrate to the same picture
 * (see agents/knowledge-profiler and services/learnerProfile.service).
 *
 * The two sources overlap on weekly hours, goal and style; course-maker-tools
 * omits those from `learner` whenever a measured profile exists, so whichever
 * arrives here is the one that should be stated.
 */
export function profileLines(brief: CourseBrief): string[] {
  const who = brief.learner ? [brief.learner, ""] : [];
  const p = brief.profile;
  if (!p) {
    const bare = brief.priorKnowledge ? [...who, `Prior knowledge: ${brief.priorKnowledge}`] : who;
    return [...bare, ...intakeLines(brief)];
  }
  const lines = [...who, `Assessed level: ${p.level}`];
  if (p.goal) lines.push(`Their goal: ${p.goal}`);
  if (p.knownConcepts.length) lines.push(`Already knows (skip or move fast): ${p.knownConcepts.join(", ")}`);
  if (p.gapConcepts.length) lines.push(`Gaps to spend real depth on: ${p.gapConcepts.join(", ")}`);
  if (p.diagnosticScore != null) {
    lines.push(`Diagnostic quiz score: ${p.diagnosticScore}% — trust this over what they claimed.`);
  } else {
    // Saying nothing let the model read an absent score as a bad one. The
    // intake director skips the diagnostic for students it cannot usefully
    // test, so "not measured" is a normal outcome, not a failed exam.
    lines.push("No diagnostic was asked — judge their level from the notes above, not from a missing score.");
  }
  if (p.weeklyHours) lines.push(`Study time available: about ${p.weeklyHours} hours a week`);
  if (p.styleNotes) lines.push(`Learning preferences: ${p.styleNotes}`);
  if (p.summary) lines.push(`Summary: ${p.summary}`);
  return [...lines, ...intakeLines(brief)];
}

/** The guided intake's brief — what to DO about the profile above. */
function intakeLines(brief: CourseBrief): string[] {
  const lines: string[] = [];
  if (brief.startFrom) {
    lines.push(`START THE COURSE FROM: ${brief.startFrom} — chapter 1 must begin here, not earlier and not later.`);
  }
  if (brief.skip?.length) {
    lines.push(`Do NOT re-teach (they have already proven it): ${brief.skip.join(", ")}`);
  }
  if (brief.needsSetupLesson) {
    // Read by the outline AND by every chapter writer (profileLines is shared),
    // so it must say the same true thing to both. It used to say "the FIRST
    // chapter must open with an installation lesson" — the outline turned that
    // into a whole setup chapter and its writer filled a chapter's budget:
    // ten lessons of install, terminal, REPL and virtual environments.
    lines.push(
      "This student has no working setup yet. Installation is exactly ONE short beginner lesson — the " +
        "outline's `setupLesson` (install the runtime and one editor, run a first program). It is placed " +
        "first in chapter 1 automatically. Never plan or write any other installation or setup chapter or lesson.",
    );
  }
  if (brief.dailyMinutes) {
    lines.push(
      `They can study about ${brief.dailyMinutes} minutes at a time — keep individual lessons inside that.`,
    );
  }
  return lines;
}

export function buildCourseMakerUserMessage(
  brief: CourseBrief,
  grounding = "",
  freshness = "",
): string {
  const lines = [
    languageInstruction(brief.language ?? DEFAULT_LANGUAGE),
    "",
    `Objective: ${brief.objective}`,
    `Level: ${brief.level ?? "choose the best fit (default Beginner)"}`,
  ];
  if (brief.titleHint) lines.push(`Title hint: ${brief.titleHint}`);
  // pathBoundary (structured, from a persisted LearningPath) supersedes the
  // free-text seriesContext when present.
  if (brief.pathBoundary) lines.push("", brief.pathBoundary);
  else if (brief.seriesContext) lines.push(`Series context: ${brief.seriesContext}`);
  // The student's OTHER courses — never re-teach what they already cover.
  if (brief.existingCoverage) {
    lines.push(
      "",
      "The student ALREADY has these courses covering the ground below. Do NOT duplicate any of it — " +
        "assume it as prerequisites and only plan chapters that are genuinely new for THIS course:",
      brief.existingCoverage,
    );
  }
  lines.push(...profileLines(brief));
  if (brief.template) {
    lines.push(
      "",
      brief.template.block,
      "",
      `Write exactly ${brief.template.modules.length} chapters, one per module above, in that order.`,
    );
  }
  if (grounding) lines.push("", grounding);
  // Last, so the freshest material sits closest to the tool call.
  if (freshness) lines.push("", freshness);
  return lines.join("\n");
}

/**
 * Builds the scope-boundary block for course number `order` (1-based) in a
 * multi-course path: earlier courses become prerequisites, later ones are
 * deferred, and this course is pinned to its own slice. Pure + exported so it
 * can be unit-tested.
 */
export function buildPathBoundary(
  goal: string,
  courses: { title: string; covers?: string }[],
  order: number,
): string {
  const total = courses.length;
  const list = (from: number, to: number) =>
    courses
      .slice(from, to)
      .map((c, i) => `  ${from + i + 1}. ${c.title}${c.covers ? ` — ${c.covers}` : ""}`)
      .join("\n");

  const idx = order - 1;
  const earlier = list(0, idx);
  const later = list(idx + 1, total);
  const self = courses[idx];

  const out = [`This course is STEP ${order} OF ${total} in the learning path "${goal}".`];
  out.push(
    earlier
      ? `Earlier steps already teach the following — treat these as PREREQUISITES the student already has; do NOT re-teach them:\n${earlier}`
      : "This is the FIRST step — assume no prior courses from this path.",
  );
  if (later) {
    out.push(`Later steps will teach the following — do NOT cover these, leave them for later:\n${later}`);
  }
  if (self?.covers) out.push(`Cover ONLY this course's own slice: ${self.covers}`);
  return out.join("\n\n");
}

export function buildExpandSystemPrompt(): string {
  return `You are the curriculum writer for Saidrix AI Tutor. You are given ONE chapter of a planned course and you write it out in full. You respond ONLY by calling the emit_chapter function exactly once — never with plain text.

This chapter is yours alone: you are the only writer who will ever cover this ground. Keep it TIGHT — the course as a whole is capped, so this chapter gets only a small lesson budget (stated in the user message). Quality over quantity.

Rules:
- Break the chapter into 2 to 4 modules, in teaching order. Keep the chapter within the lesson budget you are given (a hard maximum is stated) — do NOT exceed it.
- VARY THE DEPTH: spend more lessons on the chapter's core/important topics and give minor or easy topics just one tight lesson each. Do not split trivial ideas into many lessons to fill space.
- Every lesson is ONE concrete, teachable thing with a specific title, like "Variables & Assignment" or "Handling a 404 Response" — never a vague filler like "Basics", "More concepts" or "Advanced topics".
- Cover the genuinely necessary parts (key syntax, common mistakes) but do not pad — if a lesson is not core to this chapter's brief, leave it out.
- NEVER write a lesson about installing or setting up tools (installers, editors, terminals, virtual environments). Installation, when the student needs it, is one separate lesson that is added automatically.
- summary (chapter): 2-3 sentences on what it covers and why it matters at this point in the course. Concrete, not marketing language.
- outcomes: everything the student can DO afterwards, each starting with a verb ("Write a function that…", "Explain when to use…"). Never vague ("Understand the basics").
- Module summary: one sentence. Lesson summary: one sentence saying what that single lesson teaches — specific enough that two lessons never read the same.
- Lesson brief: 2-4 sentences of INSTRUCTION for the writer who will later write this one lesson's lecture. Name the actual concepts and terms it must introduce, the worked example it should build, and the common mistake it must warn about, plus the boundary it must not cross into a sibling lesson. Write it to that writer, not to the student — it is never displayed.
- durationMin: a realistic single-lesson length (usually 10-45 minutes). estimatedHours: the chapter's total, roughly consistent with its lessons.
- difficulty: this chapter's own level, which may be below or above the course level.
- Do not teach what neighbouring chapters cover — you are told their titles so you can stay in your lane.
- Write everything in the language the LANGUAGE line gives you.

TEACH THIS CHAPTER AS IT IS TODAY. Your message carries a CURRENT INFORMATION block from a live web search run today. It OVERRIDES your training data, which is older than it. Your lesson briefs are the instructions the lecture writer follows, so whatever you get wrong here is written into the actual lessons:
- Name the CURRENT APIs, syntax, package names and tooling in the briefs — not the ones you remember.
- Do not spend a lesson on an approach the search shows as deprecated, superseded or removed. Spend it on the replacement; the old way earns at most one line inside another lesson's brief.
- Never write a version number, release date or "as of" claim into a title, summary or brief unless the search block supports it. Describe the behaviour without a number rather than guessing one — the student will type it into a terminal.`;
}

export function buildExpandUserMessage(
  course: Pick<GeneratedCourse, "title" | "desc" | "level">,
  brief: CourseBrief,
  chapters: GeneratedCourse["chapters"],
  index: number,
  grounding = "",
  budget = 0,
  freshness = "",
): string {
  const chapter = chapters[index]!;
  const neighbours = chapters
    .map((c, i) => (i === index ? null : `${i + 1}. ${c.title}`))
    .filter((s): s is string => s !== null);

  const budgetLine = budget
    ? `Lesson budget for THIS chapter: about ${budget} lessons across 2-4 modules (hard maximum ${budget + 2}). Concentrate them on the important topics.`
    : "";

  return [
    languageInstruction(brief.language ?? DEFAULT_LANGUAGE),
    "",
    `Course: ${course.title} (${course.level})`,
    `Course description: ${course.desc}`,
    `Student's objective: ${brief.objective}`,
    ...profileLines(brief),
    neighbours.length ? `Other chapters (do not teach these): ${neighbours.join("; ")}` : "",
    "",
    `Write chapter ${index + 1} of ${chapters.length} in full: ${chapter.title}`,
    `What this chapter must cover: ${chapter.brief}`,
    budgetLine,
    grounding ? `\n${grounding}` : "",
    freshness ? `\n${freshness}` : "",
    "",
    "Call emit_chapter with the modules and lessons this chapter needs, within the budget.",
  ]
    .filter(Boolean)
    .join("\n");
}
