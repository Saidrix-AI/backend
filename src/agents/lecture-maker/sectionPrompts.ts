import {
  formatBlueprintForPlanner,
  formatBlueprintForWorker,
  formatSetupBlueprintForPlanner,
  formatSetupBlueprintForWorker,
  lectureLanguageLine,
  lectureLearnerLines,
  setupOsLine,
  type LessonContext,
} from "./prompt.js";
import type { LessonBlueprint, LessonKind, OutlineItem, SetupBlueprint } from "./schema.js";
import type { LectureOutline } from "./sections.js";

/**
 * Prompts for the v3 lecture: one outline planner, one section writer per
 * topic, one quiz writer. The blueprint projections and the language/learner
 * lines are shared with the analyst stage in prompt.ts.
 */

export type Blueprint = { kind: "concept"; bp: LessonBlueprint } | { kind: "setup"; bp: SetupBlueprint };

const NO_FILLER = `PROFESSIONAL CONTENT ONLY. The page is a textbook, not a blog post. Never write tips, hints, "pro tip", "note:", "remember", "don't worry", "fun fact", motivational lines, or suggestions to the reader. Never address the reader about the lecture itself ("in this section we will…"). State the material: definitions, mechanisms, worked examples, real code, comparisons. The live AI tutor does all the explaining, encouraging and warning out loud — that material goes in the section's "tutor" fields, never on the page.`;

const KINDS = `SECTION KINDS — every section is taught in exactly one place:
- theory: read on the page. Definitions, explanation, tables, read-only code snippets, formulas.
- practical: the tutor opens the Code Lab, TYPES the program and RUNS it while explaining. Use it only for a small, complete, runnable program whose output teaches something (a loop's iterations, an error and its fix, a server answering). At most one or two per topic.
- canvas: the tutor DRAWS it on the whiteboard step by step — a process, a flow, a structure, a comparison. Its page content is a mermaid flowchart (≤8 boxes) or a tree.
Most sections are theory. A good lecture mixes in practical and canvas where they genuinely teach better than reading.`;

export function buildOutlineSystemPrompt(kind: LessonKind): string {
  const arc =
    kind === "setup"
      ? `THE ARC (installation guide): what we are installing and why → download and install, one topic per stage in the analysis → verify it works → fixing common problems. Every install step is a theory section with the exact commands; there are NO practical sections in a setup guide (the Code Lab cannot install software on the student's computer). The final topic ends with a verification checklist.`
      : `THE ARC: why this matters (a real situation) → one topic per concept in the analysis, easiest first → putting it together on the main worked example → recap. Do NOT plan a quiz — it is written separately and appended.`;
  return `You plan one lecture for Saidrix AI Tutor. The lesson has already been analysed; turn the analysis into an outline of topics, and break each topic into SECTIONS.

${arc}

${KINDS}

Rules:
- 4-10 topics, each with an m:ss duration. 1-5 sections per topic; a section is ONE teachable idea.
- Every brief must be specific enough for a separate writer who cannot ask you anything: name the worked example from the analysis, the exact code goal and language for practical sections, and what is drawn for canvas sections.
- Build one worked example progressively across the lecture.
- Stay inside this lesson; never re-teach the sibling lessons.
- Where the analysis has a "CURRENT AS OF TODAY" section, plan around those versions and practices.`;
}

export function buildOutlineUserMessage(ctx: LessonContext, blueprint: Blueprint): string {
  return [
    lectureLanguageLine(ctx),
    "",
    `Course: ${ctx.courseTitle}${ctx.courseDesc ? ` — ${ctx.courseDesc}` : ""} (Level: ${ctx.level})`,
    `Location: ${ctx.chapterTitle} → ${ctx.moduleTitle}`,
    `Plan the lecture for the lesson: "${ctx.topicTitle}"`,
    ...(blueprint.kind === "setup" ? [setupOsLine(ctx)] : []),
    ...lectureLearnerLines(ctx),
    ...(ctx.siblingTopics.length > 0 ? [`Sibling lessons (do NOT re-teach): ${ctx.siblingTopics.join("; ")}`] : []),
    "",
    blueprint.kind === "setup" ? formatSetupBlueprintForPlanner(blueprint.bp) : formatBlueprintForPlanner(blueprint.bp),
  ].join("\n");
}

export function buildSectionWriterSystemPrompt(kind: LessonKind): string {
  return `You write ONE topic of a lecture for Saidrix AI Tutor: its planned sections, each with what the student sees on the page and how the live AI tutor teaches it.

${NO_FILLER}

${KINDS}

Emit exactly the planned sections, in order, with the planned kinds.

PAGE CONTENT (blocks) — 1-8 per section, written for someone seeing this for the first time:
- paragraph: precise explanation, 2-6 sentences, concrete.
- list: 3-10 parallel items (steps, properties, rules).
- code: correct, complete, runnable, under ~40 lines, ALWAYS with "language". In a practical section this is the exact program the tutor will type and run — put it first.
- table: comparable facts; rows the same length as columns.
- math: raw LaTeX in "tex", no $.
- mermaid: valid Mermaid in "code" + one-sentence "alt". Default to "flowchart TD", at most 8 nodes, node names short English identifiers (labels in the lecture language, in double quotes when they hold punctuation), each statement on its own line, no subgraph/style/classDef/click. A canvas section's first block is its mermaid or tree.
- tree: a real hierarchy: root {name, attributes?, children?} + "alt".
- chart: only genuinely numeric data.
${kind === "setup" ? "- checklist: the final topic's last section ends with one — checks with the exact command and expected output." : "- Do not write a quiz; it is written separately."}
Do not write headings — the section title is shown as the heading.

TUTOR (never shown to the student):
- goal: what they can do afterwards.
- explain: the explanation as points the tutor says in its own words — the why, the intuition, how to read the code or diagram. This is where the teaching lives.
- deeper: what a student who already knew the basics does not know yet.
- analogy (optional), misconceptions (only real ones, with what breaks and the correction).
- ask (optional): an opening question with the points a knowing student would mention; worth "ask" only when a learner at this level plausibly knows something already.
- check: the understanding bar as a rubric; weight "key" for load-bearing ideas, "light" otherwise.
- demo: for practical/canvas — what the student must notice while it runs or is drawn.

Use the shared worked example exactly as named. Teach only your topic; the full outline is given so you do not repeat a neighbour. Where a "CURRENT AS OF TODAY" section exists it overrides your memory; never invent a version number. Write every text field in the lecture language.`;
}

export function buildSectionWriterUserMessage(
  ctx: LessonContext,
  outline: LectureOutline,
  topicIndex: number,
  blueprint: Blueprint,
): string {
  const topic = outline.topics[topicIndex]!;
  return [
    lectureLanguageLine(ctx),
    "",
    `Lecture: ${outline.title}`,
    `Course context: ${ctx.courseTitle} (${ctx.level}) — lesson "${ctx.topicTitle}"`,
    ...(blueprint.kind === "setup" ? [setupOsLine(ctx)] : []),
    ...lectureLearnerLines(ctx),
    "",
    "Full outline:",
    ...outline.topics.map((t, i) => `${i + 1}. ${t.title}${i === topicIndex ? "  ← YOU ARE WRITING THIS ONE" : ""}`),
    "",
    blueprint.kind === "setup" ? formatSetupBlueprintForWorker(blueprint.bp) : formatBlueprintForWorker(blueprint.bp),
    "",
    `Topic ${topicIndex + 1}: ${topic.title}${topicIndex === outline.topics.length - 1 ? " (the final topic)" : ""}`,
    `Planned sections (emit exactly ${topic.sections.length}, in order):`,
    ...topic.sections.map((s, i) => `${i + 1}. [${s.kind}] ${s.title} — ${s.brief}`),
  ].join("\n");
}

export function buildQuizSystemPrompt(): string {
  return `You write the closing exam of a lecture for Saidrix AI Tutor: 6-8 multiple-choice questions spread across the whole lecture, weighted towards the harder ideas. Test understanding — apply the idea, predict an output, spot the bug, choose between approaches — never recall of a sentence. Build distractors from the known beginner mistakes. Every question has a valid 0-based correctIndex, an explanation of why the right answer is right and the tempting one wrong, and "concept" copied exactly from the concept list. Write in the lecture language.`;
}

export function buildQuizUserMessage(
  ctx: LessonContext,
  title: string,
  outline: OutlineItem[],
  sections: { title: string; goal: string }[],
  bp: LessonBlueprint,
): string {
  return [
    lectureLanguageLine(ctx),
    "",
    `Lecture: ${title} (${ctx.level})`,
    "Topics:",
    ...outline.map((t) => `- ${t.title}`),
    "",
    "What each section taught:",
    ...sections.map((s) => `- ${s.title}: ${s.goal}`),
    "",
    "Concepts (copy one exactly into each question's concept):",
    ...bp.concepts.map((c) => `- ${c.name}`),
    ...(bp.misconceptions.length ? ["", "Known beginner mistakes:", ...bp.misconceptions.map((m) => `- ${m.mistake}`)] : []),
  ].join("\n");
}
