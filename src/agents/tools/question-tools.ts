import { z } from "zod";
import {
  ASK_QUESTIONS_RETRY_HINT,
  ASK_QUESTIONS_SHOWN,
  askQuestionsTool,
} from "./prompts/question.js";
import type { RegisteredTool } from "./types.js";

const askArgs = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1).max(300),
        header: z.string().min(1).max(40),
        options: z.array(z.string().min(1).max(80)).min(2).max(4),
        multiSelect: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(4),
});

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** A short chip label from the question text when the model omits `header`. */
function deriveHeader(question: string): string {
  const words = question.replace(/[?.!]+\s*$/, "").split(/\s+/).slice(0, 3).join(" ");
  return (words || "Question").slice(0, 40);
}

/**
 * gpt-4o-mini is unreliable at this nested tool schema when forced: it emits
 * questions as bare strings, uses `text`/`choices` instead of `question`/
 * `options`, omits `header`, or adds stray keys like `id`. Coerce the common
 * shapes into the canonical one so the cards render instead of erroring; items
 * that still lack a question or 2+ options are dropped (can't be an MCQ card).
 */
function normalizeQuestions(args: Record<string, unknown>): { questions: unknown[] } {
  const list = Array.isArray(args.questions)
    ? args.questions
    : Array.isArray((args as { items?: unknown }).items)
      ? ((args as { items: unknown[] }).items)
      : [];

  const out: unknown[] = [];
  for (const raw of list) {
    const r: Record<string, unknown> =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : { question: raw };
    const question = str(r.question) ?? str(r.text) ?? str(r.q) ?? str(r.title) ?? str(r.prompt);
    if (!question) continue;

    const optsRaw = r.options ?? r.choices ?? r.answers ?? r.optionsList;
    const options = Array.isArray(optsRaw)
      ? optsRaw.map(str).filter((o): o is string => Boolean(o)).slice(0, 4)
      : [];
    if (options.length < 2) continue;

    const header = str(r.header) ?? str(r.label) ?? deriveHeader(question);
    out.push({ question, header, options, multiSelect: Boolean(r.multiSelect ?? r.multi ?? false) });
  }
  return { questions: out.slice(0, 4) };
}

const askQuestions: RegisteredTool = {
  schema: askQuestionsTool,
  runningLabel: () => "Preparing questions",
  run: async (_ctx, args) => {
    const parsed = askArgs.safeParse(normalizeQuestions(args));
    if (!parsed.success) {
      return { ok: false, label: "Couldn't prepare questions", modelText: ASK_QUESTIONS_RETRY_HINT };
    }
    return {
      ok: true,
      label: `Asked ${parsed.data.questions.length} question${parsed.data.questions.length > 1 ? "s" : ""}`,
      modelText: ASK_QUESTIONS_SHOWN,
      questions: parsed.data.questions,
    };
  },
};

export const questionTools = [askQuestions];
