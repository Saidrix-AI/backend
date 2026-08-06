import { env } from "../../config/env.js";
import { getOpenAICompatClient } from "../llm.js";
import { formatZodIssues, runForcedToolCall, type LlmDeps } from "../shared/forcedToolCall.js";
import { buildGoalSystemPrompt, buildGoalUserMessage } from "./prompt.js";
import {
  emitIntakeQuestionsTool,
  GOAL_QUESTION_COUNT,
  intakeQuestionBatchSchema,
  type IntakeQuestion,
} from "./schema.js";

export type { IntakeQuestion } from "./schema.js";
export { GOAL_QUESTION_COUNT } from "./schema.js";

const MAX_OUTPUT_TOKENS = 1024;

/**
 * Used when the model is unavailable or emits something unusable. The intake is
 * a fixed four-stage machine, so a stage must never fail to produce questions —
 * generic questions are much better than a dead-ended interview.
 */
export const FALLBACK_GOAL_QUESTIONS: IntakeQuestion[] = [
  {
    header: "Goal",
    question: "What do you want to be able to do with this?",
    options: [
      "Get job-ready in it",
      "Build my own project",
      "Pass an exam or interview",
      "Understand it out of interest",
    ],
  },
  {
    header: "Target",
    question: "What would make this course a success for you?",
    options: [
      "The practical basics, fast",
      "Solid fundamentals I won't forget",
      "Deep, complete mastery",
      "A refresher on what I already met",
    ],
  },
];

function resolveIntakeDeps(): LlmDeps | null {
  const oai = getOpenAICompatClient();
  if (!oai) return null;
  return { client: oai.client, model: env.ASSESSMENT_MODEL ?? env.COURSE_MAKER_MODEL ?? oai.model };
}

/** The topic-specific goal & target questions; never throws — falls back instead. */
export async function generateGoalQuestions(
  ctx: { topic: string; objective: string },
  deps?: LlmDeps,
): Promise<IntakeQuestion[]> {
  const resolved = deps ?? resolveIntakeDeps();
  if (!resolved) return FALLBACK_GOAL_QUESTIONS;
  try {
    const batch = await runForcedToolCall({
      deps: resolved,
      tool: emitIntakeQuestionsTool,
      system: buildGoalSystemPrompt(),
      user: buildGoalUserMessage(ctx),
      parse: (raw) => {
        const r = intakeQuestionBatchSchema.safeParse(raw);
        return r.success
          ? { success: true, data: r.data }
          : { success: false, issues: formatZodIssues(r.error) };
      },
      sizeHint: "Keep every question and option short.",
      maxTokens: MAX_OUTPUT_TOKENS,
      label: "Intake questions",
    });
    const questions = batch.questions.slice(0, GOAL_QUESTION_COUNT);
    return questions.length ? questions : FALLBACK_GOAL_QUESTIONS;
  } catch {
    return FALLBACK_GOAL_QUESTIONS;
  }
}
