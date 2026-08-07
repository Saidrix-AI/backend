import type OpenAI from "openai";
import { z } from "zod";

/**
 * ONE opening question. It used to be two — "goal" and "target" — but the
 * second duplicated what the background and schedule slots now ask, and the
 * whole point of the redesign is that every question has to earn its place.
 */
export const GOAL_QUESTION_COUNT = 1;

export const intakeQuestionSchema = z.object({
  header: z.string().trim().min(1).max(40),
  question: z.string().trim().min(1).max(300),
  options: z.array(z.string().trim().min(1).max(120)).min(2).max(4),
});
export type IntakeQuestion = z.infer<typeof intakeQuestionSchema>;

/**
 * What kind of subject this is. Drives which setup questions the student is
 * asked at all — the old intake asked everybody which operating system they
 * would practise on, including someone studying for IELTS.
 *
 *  - programming     — writing code (Python, React, algorithms)
 *  - technical-tool  — software you operate but do not program (Figma, Excel,
 *                      Docker, Blender). Setup may matter; programming theory
 *                      never does.
 *  - non-technical   — everything else (languages, exams, marketing, music)
 */
export const TOPIC_KINDS = ["programming", "technical-tool", "non-technical"] as const;
export type TopicKind = (typeof TOPIC_KINDS)[number];

export const intakePlanSchema = z.object({
  topicKind: z.enum(TOPIC_KINDS).catch("non-technical"),
  needsLocalSetup: z.boolean().catch(false),
  goalQuestion: intakeQuestionSchema,
  backgroundQuestion: intakeQuestionSchema,
});
export type IntakePlan = z.infer<typeof intakePlanSchema>;

/** One question out of whatever envelope and key names the model used. */
function questionAt(raw: unknown, fallbackHeader: string): unknown {
  const q = (raw ?? {}) as Record<string, unknown>;
  const options = Array.isArray(q.options)
    ? q.options
    : Array.isArray(q.choices)
      ? q.choices
      : [];
  return {
    header: q.header ?? q.label ?? fallbackHeader,
    question: q.question ?? q.text ?? q.prompt,
    options: (options as unknown[]).map((o) => String(o).trim()).filter(Boolean).slice(0, 4),
  };
}

/**
 * Coerce before zod so a well-formed answer in the wrong envelope is not thrown
 * away — the same defence knowledge-profiler/schema.ts normalizeRound provides
 * for its rounds. Models routinely wrap both questions in a `questions` array
 * instead of using the two named keys.
 */
export function normalizePlan(raw: unknown): unknown {
  const p = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(p.questions) ? p.questions : [];

  return {
    topicKind: p.topicKind ?? p.kind ?? p.topic_kind,
    needsLocalSetup: Boolean(p.needsLocalSetup ?? p.needs_local_setup ?? p.needsSetup),
    goalQuestion: questionAt(p.goalQuestion ?? list[0], "Goal"),
    backgroundQuestion: questionAt(p.backgroundQuestion ?? p.background ?? list[1], "Background"),
  };
}

export const emitIntakePlanTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_intake_plan",
    description:
      "Classify the subject and emit the two topic-specific questions for this student's guided setup. Call exactly once.",
    parameters: {
      type: "object",
      required: ["topicKind", "needsLocalSetup", "goalQuestion", "backgroundQuestion"],
      properties: {
        topicKind: {
          type: "string",
          enum: [...TOPIC_KINDS],
          description:
            "programming = the student will write code. technical-tool = software they operate but do not program (Figma, Excel, Docker). non-technical = everything else (exams, languages, marketing, music).",
        },
        needsLocalSetup: {
          type: "boolean",
          description:
            "true ONLY if learning this genuinely requires installing something on their own computer (an editor, a runtime, an app). false for anything done in a browser, on paper, or purely conceptually.",
        },
        goalQuestion: {
          type: "object",
          required: ["header", "question", "options"],
          properties: {
            header: { type: "string", description: "Very short label, normally 'Goal'" },
            question: { type: "string", description: "The full question text" },
            options: {
              type: "array",
              description: "2-4 short, concrete outcomes specific to THIS subject",
              items: { type: "string" },
            },
          },
        },
        backgroundQuestion: {
          type: "object",
          required: ["header", "question", "options"],
          properties: {
            header: { type: "string", description: "Very short label, normally 'Background'" },
            question: { type: "string", description: "The full question text" },
            options: {
              type: "array",
              description:
                "2-4 options describing how much of THIS subject they have actually done, from nothing to daily use",
              items: { type: "string" },
            },
          },
        },
      },
    },
  },
};
