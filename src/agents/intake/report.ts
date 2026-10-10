import type OpenAI from "openai";
import { z } from "zod";
import { env } from "../../config/env.js";
import { LEVELS } from "../../validation/course.schema.js";
import { languageInstruction, type Language } from "../../validation/language.js";
import { getModelName, hasOpenAICompatProvider } from "../llm.js";
import { formatZodIssues, runForcedToolCall, type LlmDeps } from "../shared/forcedToolCall.js";
import {
  emittedProfileSchema,
  normalizeProfile,
  type KnowledgeProfile,
} from "../knowledge-profiler/schema.js";
import type { IntakeAnswer } from "./director.js";

/**
 * The closing call of the guided intake: everything the student said, turned
 * into one brief the curriculum designer can act on.
 *
 * WHY. The intake used to hand the chat agent a dump of raw "Header: answer"
 * lines and let it re-read them, and the course-maker pulled only the language
 * off the intake. Nothing ever said "start here, skip that" in a form a
 * generator could use.
 *
 * SHAPE. Deliberately the existing KnowledgeProfile plus two fields. That is
 * what keeps the blast radius small: assessment.service.latestProfile,
 * course-maker/prompt.profileLines and assessment.recordQuizOutcome (lecture
 * exams folding back into the profile) all keep working untouched.
 *
 * `needsSetupLesson` is NOT here on purpose — the tools slot answers it
 * deterministically, and a model asked to re-derive it would sometimes disagree
 * with what the student just clicked.
 */

export interface IntakeReport extends KnowledgeProfile {
  /** Where chapter 1 should begin, in one line. */
  startFrom: string;
  /** Ground the course must NOT re-teach. */
  skip: string[];
}

const reportSchema = emittedProfileSchema.extend({
  startFrom: z.string().trim().max(300).default(""),
  skip: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
});

const emitIntakeReportTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_intake_report",
    description:
      "Emit the student's learning brief from their intake answers. Call exactly once.",
    parameters: {
      type: "object",
      required: [
        "level",
        "startFrom",
        "skip",
        "knownConcepts",
        "gapConcepts",
        "goal",
        "weeklyHours",
        "styleNotes",
        "summary",
      ],
      properties: {
        level: {
          type: "string",
          enum: [...LEVELS],
          description: "The level the course should START at, judged from evidence rather than claims",
        },
        startFrom: {
          type: "string",
          description:
            "One line naming the first thing the course should teach this specific student, e.g. 'what a variable is — no programming background at all'",
        },
        skip: {
          type: "array",
          items: { type: "string" },
          description: "Ground they have already proven, which the course must not spend chapters on",
        },
        knownConcepts: {
          type: "array",
          items: { type: "string" },
          description: "Concepts they demonstrably know — the course can move fast through these",
        },
        gapConcepts: {
          type: "array",
          items: { type: "string" },
          description: "Concepts they got wrong or have never met — the course must spend real depth here",
        },
        goal: { type: "string", description: "What they want to be able to do, in their words" },
        weeklyHours: { type: "integer", description: "Hours a week they can study (0 if not stated)" },
        styleNotes: { type: "string", description: "Pace and format preferences, one short line" },
        summary: {
          type: "string",
          description:
            "3-5 sentences a curriculum designer could act on. Written TO the student's tutor, never to the student.",
        },
      },
    },
  },
};

function buildSystemPrompt(): string {
  return `You are the intake analyst for Saidrix AI Tutor. A student has just finished a short guided setup. Turn their answers into the brief the curriculum designer will build their course from. You respond ONLY by calling emit_intake_report exactly once.

Rules:
- Judge "level" from EVIDENCE, not from claims. If they answered diagnostic questions, those outweigh anything they said about themselves: a student who calls themselves advanced but missed the fundamentals is Beginner, and one who called themselves a beginner and answered everything correctly is not.
- If no diagnostic was asked, say so in the summary and judge from what they told you — do not invent a measurement that never happened.
- startFrom must be specific to THIS student, not to the subject. "Variables and data types" is a syllabus; "what a variable even is — they have never written code and do not have an editor yet" is a brief.
- skip and knownConcepts: only ground they actually demonstrated or clearly described. An empty list is the correct answer for a beginner — never pad it.
- gapConcepts: what they got wrong, plus anything their goal needs that never came up.
- goal and styleNotes come from their own words.
- summary: 3-5 sentences — where to start, what to skip, what to spend real time on, and anything about their setup or their schedule that changes how the course should be shaped.
- Write the text fields in the language the LANGUAGE line gives you.`;
}

function buildUserMessage(ctx: {
  topic: string;
  objective: string;
  answers: IntakeAnswer[];
  diagnostic: { correct: number; total: number; score: number | null } | null;
  language: Language;
}): string {
  const transcript = ctx.answers.length
    ? ctx.answers.map((a) => `${a.header}: ${a.question}\n   answered: ${a.answer}`).join("\n")
    : "(no answers recorded)";

  return [
    languageInstruction(ctx.language),
    "",
    `Topic: ${ctx.topic}`,
    `What the student asked for: ${ctx.objective}`,
    ctx.diagnostic && ctx.diagnostic.total > 0
      ? `Diagnostic result: ${ctx.diagnostic.correct} of ${ctx.diagnostic.total} correct (${ctx.diagnostic.score}%). This is MEASURED, not self-reported — weight it above everything else here.`
      : "No diagnostic questions were asked — there is no measured score for this student.",
    "",
    "Their answers:",
    transcript,
    "",
    "Call emit_intake_report.",
  ]
    .filter(Boolean)
    .join("\n");
}

function resolveDeps(): LlmDeps | null {
  if (!hasOpenAICompatProvider()) return null;
  return { model: env.ASSESSMENT_MODEL ?? env.COURSE_MAKER_MODEL ?? getModelName() };
}

/**
 * Mechanical fallback. The report is the only thing standing between a finished
 * intake and a course, so losing the model must not lose the interview — a
 * thin brief built from the answers still beats no brief at all.
 */
function fallbackReport(
  answers: IntakeAnswer[],
  diagnosticScore: number | null,
): IntakeReport {
  const level: (typeof LEVELS)[number] =
    diagnosticScore == null ? "Beginner" : diagnosticScore >= 85 ? "Advanced" : diagnosticScore >= 60 ? "Intermediate" : "Beginner";
  const said = answers.map((a) => `${a.header}: ${a.answer}`).join("; ");
  return {
    level,
    startFrom: "",
    skip: [],
    knownConcepts: [],
    gapConcepts: [],
    goal: answers.find((a) => /goal/i.test(a.header))?.answer ?? "",
    weeklyHours: 0,
    styleNotes: "",
    summary: `Start at ${level} level. From their setup answers: ${said}`.slice(0, 600),
    diagnosticScore,
  };
}

/**
 * The finished brief. `diagnosticScore` is computed by the caller and handed
 * over as a fact — the model is never asked to work out how well they did.
 */
export async function buildIntakeReport(
  ctx: {
    topic: string;
    objective: string;
    answers: IntakeAnswer[];
    diagnostic: { correct: number; total: number; score: number | null } | null;
    language: Language;
  },
  deps?: LlmDeps,
): Promise<IntakeReport> {
  const score = ctx.diagnostic?.score ?? null;
  const resolved = deps ?? resolveDeps();
  if (!resolved) return fallbackReport(ctx.answers, score);

  try {
    const emitted = await runForcedToolCall({
      deps: resolved,
      tool: emitIntakeReportTool,
      system: buildSystemPrompt(),
      user: buildUserMessage(ctx),
      parse: (raw) => {
        const root = (raw ?? {}) as Record<string, unknown>;
        // normalizeProfile already coerces the shapes models actually emit
        // (lowercase levels, concepts as a comma string, hours as "5-7"); the
        // two extra fields are folded in beside its output.
        const base = normalizeProfile(raw) as Record<string, unknown>;
        const r = reportSchema.safeParse({
          ...base,
          startFrom: root.startFrom ?? root.start_from ?? "",
          skip: Array.isArray(root.skip)
            ? root.skip
            : typeof root.skip === "string"
              ? root.skip.split(/[,;\n]/)
              : [],
        });
        return r.success
          ? { success: true, data: r.data }
          : { success: false, issues: formatZodIssues(r.error) };
      },
      sizeHint: "Keep the summary to three sentences and list fewer concepts.",
      maxTokens: 2048,
      label: "Intake report",
    });
    return { ...emitted, diagnosticScore: score };
  } catch (err) {
    console.warn(
      "[intake] report generation failed, using the mechanical fallback:",
      err instanceof Error ? err.message : err,
    );
    return fallbackReport(ctx.answers, score);
  }
}
