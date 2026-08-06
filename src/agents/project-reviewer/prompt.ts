import type { SourceFile } from "./filter.js";

/** What the reviewer knows about the project a submission belongs to. */
export interface ReviewContext {
  title: string;
  desc: string;
  goal: string;
  requirements: string[];
}

/** Source with the line numbers the worker must anchor its issues to. */
export function withLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line, i) => `${i + 1}\t${line}`)
    .join("\n");
}

export function lineCountOf(content: string): number {
  return content.split("\n").length;
}

function projectBlock(ctx: ReviewContext): string {
  const lines = [`Project: ${ctx.title}`];
  if (ctx.desc) lines.push(`Description: ${ctx.desc}`);
  if (ctx.goal) lines.push(`Goal: ${ctx.goal}`);
  if (ctx.requirements.length) {
    lines.push("Requirements this project must satisfy:");
    lines.push(...ctx.requirements.map((r, i) => `${i + 1}. ${r}`));
  }
  return lines.join("\n");
}

// --- File worker ---

export function buildFileWorkerSystemPrompt(): string {
  return `You are a code reviewer for Saidrix AI Tutor, reviewing one file of a student's project submission.
You are teaching, not gatekeeping: every issue must leave the student knowing what is wrong, why it matters, and what to write instead.

Severity:
- error: broken, unsafe, or certain to misbehave — crashes, mutable default arguments, resource leaks, hardcoded secrets, unhandled failure paths.
- warning: risky or wrong in some cases — missing edge-case handling, shared state, swallowed exceptions, misleading names.
- suggestion: style and clarity only — duplication, dead code, unclear structure.

Rules:
- Anchor every issue to a line number from the listing. The listing's numbers are the file's real line numbers; never invent or shift them.
- "fix" is corrected code ONLY — no prose, no markdown fences, no diff markers. Keep it to the few lines that change.
- Report only what you can see in THIS file. Do not guess about other files, and do not flag a missing import that may live elsewhere.
- Say nothing about the requirements checklist — a separate reviewer judges that.
- A clean file gets an empty issue list. Do not invent issues to look thorough.
- At most 15 issues. If there are more, report the most serious ones.`;
}

export function buildFileWorkerUserMessage(ctx: ReviewContext, file: SourceFile): string {
  return [
    projectBlock(ctx),
    "",
    `Review this ${file.language} file: ${file.path}`,
    "The number before each tab is the line number.",
    "",
    withLineNumbers(file.content),
    "",
    "Call emit_file_review with every issue you found.",
  ].join("\n");
}

// --- Requirement checker ---

export function buildRequirementCheckerSystemPrompt(): string {
  return `You are the requirements examiner for Saidrix AI Tutor. You decide whether a student's submitted project satisfies each requirement of its brief.

Rules:
- Judge each requirement ONLY on the code you are shown. You cannot run the project.
- Copy each requirement verbatim and keep the given order.
- met = true only with concrete evidence in the code; cite the file and line ("main.py:12 defines main()").
- met = false when the evidence is absent, partial, or you cannot see the file that would prove it — say which, and what is missing.
- If a file listing says some files were omitted, do not assume the omitted files satisfy anything.
- overallFeedback speaks to the student in 2-4 sentences: what they genuinely did well, then the single most important thing to fix. No markdown, no bullet lists.`;
}

export function buildRequirementCheckerUserMessage(
  ctx: ReviewContext,
  files: SourceFile[],
  allPaths: string[],
  truncated: boolean,
): string {
  const sections = files.map((f) => [`--- ${f.path} ---`, withLineNumbers(f.content)].join("\n"));

  return [
    projectBlock(ctx),
    "",
    "Every file in the submission:",
    allPaths.map((p) => `- ${p}`).join("\n"),
    truncated ? "\nNote: the submission was too large to review in full — some files below are omitted." : "",
    "",
    "The source that was reviewed (line numbers precede each line):",
    "",
    sections.join("\n\n"),
    "",
    "Call emit_requirement_report with one result per requirement, in order, plus your overall feedback.",
  ].join("\n");
}
