import type OpenAI from "openai";
import { z } from "zod";
import { LEVELS } from "../../validation/course.schema.js";

/**
 * ONE round of three questions.
 *
 * This was four rounds of four — a sixteen-question exam every student sat
 * through before any course existed, and the single biggest source of the
 * irrelevant questions the intake redesign removed. Rounds 1 and 4 asked about
 * goals, time and preferences, which the intake slots now own; rounds 2 and 3
 * fired eight code diagnostics at everyone, including people who had just said
 * they had never written a line.
 *
 * What survives is the part that only a question can establish: a short,
 * calibrated probe, asked only when the intake director judges it would change
 * where the course starts (agents/intake/director.ts).
 */
export const TOTAL_ROUNDS = 1;
export const QUESTIONS_PER_ROUND = 3;

export const QUESTION_KINDS = ["self_report", "diagnostic"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/**
 * One question as the model emits it. Diagnostic questions have a right answer
 * (`correctIndex`) and name the `concept` they test — neither ever leaves the
 * server; assessment.service strips both before the payload reaches the client.
 */
export const generatedQuestionSchema = z
  .object({
    header: z.string().trim().min(1).max(40),
    question: z.string().trim().min(1).max(300),
    options: z.array(z.string().trim().min(1).max(120)).min(2).max(4),
    multiSelect: z.boolean().default(false),
    kind: z.enum(QUESTION_KINDS).catch("self_report"),
    correctIndex: z.number().int().min(0).max(3).optional(),
    concept: z.string().trim().max(80).optional(),
  })
  .superRefine((q, ctx) => {
    if (q.kind !== "diagnostic") return;
    if (q.correctIndex == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correctIndex"],
        message: "a diagnostic question must say which option is correct",
      });
      return;
    }
    if (q.correctIndex >= q.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correctIndex"],
        message: `correctIndex ${q.correctIndex} is outside the ${q.options.length} options`,
      });
    }
  });
export type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>;

// A short round can still be scored and profiled, so the count is not enforced
// hard — the prompt asks for exactly four and the caller trims the overflow.
export const questionBatchSchema = z.object({
  questions: z.array(generatedQuestionSchema).min(2).max(6),
});

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Coerces the shapes models actually emit into the canonical one before zod
 * sees them. glm-5.2 names the right answer half a dozen ways (`answer`,
 * `correct`, `correctAnswer`, a 1-based number, the option text itself) and
 * sometimes omits `kind` — and because a whole round is one tool call, a single
 * malformed question used to fail all four. A question whose correct option
 * cannot be resolved is demoted to self_report (unscored) rather than dropped,
 * so the student still gets a full round.
 */
export function normalizeRound(raw: unknown): unknown {
  const root = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.questions)
    ? root.questions
    : Array.isArray(root.items)
      ? (root.items as unknown[])
      : Array.isArray(raw)
        ? (raw as unknown[])
        : [];

  const questions: unknown[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const q = entry as Record<string, unknown>;

    const question = text(q.question) ?? text(q.text) ?? text(q.prompt) ?? text(q.q);
    const rawOptions = q.options ?? q.choices ?? q.answers ?? q.optionsList;
    const options = Array.isArray(rawOptions)
      ? rawOptions.map(text).filter((o): o is string => Boolean(o)).slice(0, 4)
      : [];
    if (!question || options.length < 2) continue;

    const correctIndex = resolveCorrectIndex(q, options);
    const kind =
      q.kind === "diagnostic" || q.kind === "self_report"
        ? q.kind
        : correctIndex != null
          ? "diagnostic"
          : "self_report";

    questions.push({
      header: (text(q.header) ?? text(q.label) ?? question).slice(0, 40),
      question,
      options,
      multiSelect: Boolean(q.multiSelect ?? q.multi ?? false),
      // A diagnostic with no resolvable answer cannot be scored — keep the
      // question, drop the claim that it tests something.
      kind: kind === "diagnostic" && correctIndex == null ? "self_report" : kind,
      ...(correctIndex == null ? {} : { correctIndex }),
      ...(text(q.concept) ? { concept: text(q.concept) } : {}),
    });
  }
  return { questions };
}

/** The right answer as a 0-based index, however the model expressed it. */
function resolveCorrectIndex(
  q: Record<string, unknown>,
  options: string[],
): number | undefined {
  const raw = q.correctIndex ?? q.correct_index ?? q.correct ?? q.answer ?? q.correctAnswer;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Some models number the options from 1.
    const index = raw >= options.length && raw - 1 < options.length ? raw - 1 : raw;
    return index >= 0 && index < options.length ? index : undefined;
  }
  const asText = text(raw);
  if (!asText) return undefined;
  const byText = options.findIndex((o) => o.toLowerCase() === asText.toLowerCase());
  if (byText >= 0) return byText;
  // "B" or "2" as a letter/number label.
  const letter = /^[a-d]$/i.test(asText) ? asText.toLowerCase().charCodeAt(0) - 97 : -1;
  if (letter >= 0 && letter < options.length) return letter;
  const numeric = Number(asText);
  if (Number.isInteger(numeric)) {
    const index = numeric >= options.length ? numeric - 1 : numeric;
    if (index >= 0 && index < options.length) return index;
  }
  return undefined;
}

export const emitQuestionsTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_questions",
    description: `Emit this round's questions. Call exactly once with exactly ${QUESTIONS_PER_ROUND} questions.`,
    parameters: {
      type: "object",
      required: ["questions"],
      properties: {
        questions: {
          type: "array",
          description: `Exactly ${QUESTIONS_PER_ROUND} multiple-choice questions`,
          items: {
            type: "object",
            required: ["header", "question", "options", "kind"],
            properties: {
              header: { type: "string", description: "Very short label, e.g. 'Experience' or 'Loops'" },
              question: { type: "string", description: "The full question text" },
              options: {
                type: "array",
                description: "2-4 short answer choices",
                items: { type: "string" },
              },
              multiSelect: {
                type: "boolean",
                description: "true only for self_report questions where several answers can be true at once",
              },
              kind: {
                type: "string",
                enum: [...QUESTION_KINDS],
                description:
                  "self_report asks about them (goal, experience, time). diagnostic tests whether they actually know something and has exactly one correct option.",
              },
              correctIndex: {
                type: "integer",
                description: "REQUIRED for diagnostic: 0-based index of the one correct option",
              },
              concept: {
                type: "string",
                description: "For diagnostic: the concept being tested, e.g. 'list slicing'",
              },
            },
          },
        },
      },
    },
  },
};

/** The profile the model writes from the answers; diagnosticScore is added in code. */
export const emittedProfileSchema = z.object({
  level: z.enum(LEVELS),
  knownConcepts: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
  gapConcepts: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
  goal: z.string().trim().max(300).default(""),
  weeklyHours: z.number().int().min(0).max(100).catch(0),
  styleNotes: z.string().trim().max(300).default(""),
  summary: z.string().trim().min(1).max(600),
});

const LEVEL_ALIASES: [RegExp, (typeof LEVELS)[number]][] = [
  [/advanc|expert|pro\b/i, "Advanced"],
  [/intermediate|mid\b|moderate/i, "Intermediate"],
  [/beginner|basic|novice|starter|zero/i, "Beginner"],
];

function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 12);
  if (typeof v === "string" && v.trim()) {
    return v.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
  }
  return [];
}

/**
 * Same job as normalizeRound, for the closing profile call: the profile is the
 * only thing standing between a finished knowledge check and a course, so a
 * loosely-shaped emission (lowercase level, concepts as a comma string, hours
 * as "5-7") must not throw the whole assessment away.
 */
export function normalizeProfile(raw: unknown): unknown {
  const p = (raw ?? {}) as Record<string, unknown>;
  const levelText = String(p.level ?? p.startLevel ?? "");
  const level = LEVEL_ALIASES.find(([pattern]) => pattern.test(levelText))?.[1] ?? "Beginner";

  const hoursRaw = p.weeklyHours ?? p.hoursPerWeek ?? p.weekly_hours;
  const hours =
    typeof hoursRaw === "number"
      ? Math.round(hoursRaw)
      : Number.parseInt(String(hoursRaw ?? "").replace(/[^0-9].*$/, ""), 10);

  const known = stringList(p.knownConcepts ?? p.known_concepts ?? p.known);
  const gaps = stringList(p.gapConcepts ?? p.gap_concepts ?? p.gaps);
  const summary = String(p.summary ?? p.notes ?? "").trim();

  return {
    level,
    knownConcepts: known,
    gapConcepts: gaps,
    goal: String(p.goal ?? p.objective ?? "").trim().slice(0, 300),
    weeklyHours: Number.isFinite(hours) && hours >= 0 ? Math.min(hours, 100) : 0,
    styleNotes: String(p.styleNotes ?? p.style_notes ?? p.preferences ?? "").trim().slice(0, 300),
    // The schema requires a non-empty summary; a mechanical one beats losing
    // sixteen answered questions.
    summary: (summary ||
      `Start at ${level} level.${gaps.length ? ` Spend real time on: ${gaps.join(", ")}.` : ""}`
    ).slice(0, 600),
  };
}

/** What the Course-maker consumes. `diagnosticScore` is computed, never inferred. */
export interface KnowledgeProfile extends z.infer<typeof emittedProfileSchema> {
  /** Percentage of diagnostic questions answered correctly, or null if none were asked. */
  diagnosticScore: number | null;
}

export const emitProfileTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_profile",
    description: "Emit the student's knowledge profile from their answers. Call exactly once.",
    parameters: {
      type: "object",
      required: ["level", "knownConcepts", "gapConcepts", "goal", "weeklyHours", "styleNotes", "summary"],
      properties: {
        level: {
          type: "string",
          enum: [...LEVELS],
          description: "The level the course should start at, judged from the diagnostic results",
        },
        knownConcepts: {
          type: "array",
          items: { type: "string" },
          description: "Concepts they demonstrably know — the course can move fast through these",
        },
        gapConcepts: {
          type: "array",
          items: { type: "string" },
          description: "Concepts they got wrong or have never met — the course must spend real time here",
        },
        goal: { type: "string", description: "What they want to be able to do, in their words" },
        weeklyHours: { type: "integer", description: "Hours a week they can study (0 if not stated)" },
        styleNotes: { type: "string", description: "Pace and format preferences, one short line" },
        summary: {
          type: "string",
          description: "2-3 sentences a curriculum designer could act on. Written TO the student's tutor, not to them.",
        },
      },
    },
  },
};
