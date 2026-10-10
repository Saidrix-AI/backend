import { env } from "../../config/env.js";
import { DEFAULT_LANGUAGE, type Language } from "../../validation/language.js";
import { getModelName, hasOpenAICompatProvider } from "../llm.js";
import { formatZodIssues, runForcedToolCall, type LlmDeps } from "../shared/forcedToolCall.js";
import { buildPlanSystemPrompt, buildPlanUserMessage } from "./prompt.js";
import {
  emitIntakePlanTool,
  intakePlanSchema,
  normalizePlan,
  type IntakePlan,
  type IntakeQuestion,
  type TopicKind,
} from "./schema.js";

export type { IntakeQuestion, IntakePlan, TopicKind } from "./schema.js";
export { GOAL_QUESTION_COUNT, TOPIC_KINDS } from "./schema.js";

const MAX_OUTPUT_TOKENS = 1024;

/**
 * Used when the model is unavailable or emits something unusable. The intake is
 * a fixed stage machine, so a stage must never fail to produce a question — a
 * generic one is much better than a dead-ended interview.
 */
export const FALLBACK_GOAL_QUESTION: IntakeQuestion = {
  header: "Goal",
  question: "What do you want to be able to do with this?",
  options: [
    "Get job-ready in it",
    "Build my own project",
    "Pass an exam or interview",
    "Understand it out of interest",
  ],
};

/** Evidence-shaped, not confidence-shaped — see the prompt for why. */
export const FALLBACK_BACKGROUND_QUESTION: IntakeQuestion = {
  header: "Background",
  question: "How much of this have you actually done before?",
  options: [
    "Nothing at all — starting from zero",
    "Read or watched a bit, never practised",
    "Practised a little on my own",
    "I use it already and want to go deeper",
  ],
};

/** Subjects where you write code. */
const PROGRAMMING_HINT =
  /\b(python|javascript|typescript|java|kotlin|swift|c\+\+|c#|golang|go lang|rust|php|ruby|scala|dart|sql|react|vue|angular|svelte|next\.?js|node|django|flask|laravel|spring|programming|coding|code|algorithm|data structure|backend|front[- ]?end|full[- ]?stack|web dev|app dev|machine learning|deep learning|data science|api)\b/i;

/** Software you operate rather than program. */
const TOOL_HINT =
  /\b(figma|photoshop|illustrator|premiere|after effects|blender|excel|power ?bi|tableau|docker|kubernetes|git\b|linux|autocad|canva|notion|unity|unreal|davinci)\b/i;

/** Subjects that plainly need something installed locally. */
const LOCAL_SETUP_HINT =
  /\b(python|javascript|typescript|java|kotlin|swift|c\+\+|c#|golang|rust|php|ruby|react|vue|angular|svelte|next\.?js|node|django|flask|laravel|spring|docker|kubernetes|git\b|linux|unity|unreal|blender|android|ios|embedded|arduino)\b/i;

/**
 * Last-resort classification when the model call fails. Deliberately
 * conservative in the direction of ASKING: a false "non-technical" would deny a
 * Python student their setup lesson, which is worse than one extra question.
 */
export function guessTopicShape(text: string): { topicKind: TopicKind; needsLocalSetup: boolean } {
  if (PROGRAMMING_HINT.test(text)) return { topicKind: "programming", needsLocalSetup: true };
  if (TOOL_HINT.test(text)) {
    return { topicKind: "technical-tool", needsLocalSetup: LOCAL_SETUP_HINT.test(text) };
  }
  return { topicKind: "non-technical", needsLocalSetup: false };
}

function resolveIntakeDeps(): LlmDeps | null {
  if (!hasOpenAICompatProvider()) return null;
  return { model: env.ASSESSMENT_MODEL ?? env.COURSE_MAKER_MODEL ?? getModelName() };
}

/**
 * Classifies the subject and writes the opening goal question in one call.
 * Never throws — a failure degrades to the keyword heuristic plus the fixed
 * question, which is exactly the behaviour the intake had before it could
 * classify anything at all.
 */
export async function generateIntakePlan(
  ctx: { topic: string; objective: string; language?: Language },
  deps?: LlmDeps,
): Promise<IntakePlan> {
  const fallback = (): IntakePlan => ({
    ...guessTopicShape(`${ctx.topic} ${ctx.objective}`),
    goalQuestion: FALLBACK_GOAL_QUESTION,
    backgroundQuestion: FALLBACK_BACKGROUND_QUESTION,
  });

  const resolved = deps ?? resolveIntakeDeps();
  if (!resolved) return fallback();

  try {
    return await runForcedToolCall({
      deps: resolved,
      tool: emitIntakePlanTool,
      system: buildPlanSystemPrompt(),
      user: buildPlanUserMessage({
        topic: ctx.topic,
        objective: ctx.objective,
        language: ctx.language ?? DEFAULT_LANGUAGE,
      }),
      parse: (raw) => {
        const r = intakePlanSchema.safeParse(normalizePlan(raw));
        return r.success
          ? { success: true, data: r.data }
          : { success: false, issues: formatZodIssues(r.error) };
      },
      sizeHint: "Keep the question and every option short.",
      maxTokens: MAX_OUTPUT_TOKENS,
      label: "Intake plan",
    });
  } catch {
    return fallback();
  }
}
