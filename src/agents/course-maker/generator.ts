import { env } from "../../config/env.js";
import { ApiError } from "../../utils/apiError.js";
import { getModelName, hasOpenAICompatProvider } from "../llm.js";
import { formatZodIssues, runForcedToolCall, type LlmDeps } from "../shared/forcedToolCall.js";
import { retrieveGroundingDetailed } from "../../rag/retriever.js";
import { retrieveFreshness } from "../shared/freshness.js";
import { buildCourseMakerSystemPrompt, buildCourseMakerUserMessage } from "./prompt.js";
import { emitCourseTool, generatedCourseSchema, type CourseBrief, type GeneratedCourse } from "./schema.js";

/**
 * The LLM boundary — tests mock this module (or inject a fake chat model).
 * Kept as its own alias because this resolver predates course-maker/call.ts and
 * the tests import it by this name.
 */
export type GeneratorDeps = LlmDeps;

export function resolveGeneratorDeps(): GeneratorDeps {
  if (!hasOpenAICompatProvider()) {
    throw new ApiError(503, "Course generation needs an OpenAI-compatible LLM provider (openai or openrouter).");
  }
  return { model: env.COURSE_MAKER_MODEL ?? getModelName() };
}

/**
 * One forced `emit_course` call, with a single repair round-trip covering the
 * three failure shapes: no/ignored tool call, truncated output, invalid structure.
 *
 * This used to carry its own copy of that loop, which had drifted: its
 * truncation check ran AFTER the missing-tool-call check, so a badly truncated
 * outline (no tool call at all) was reported to the model as "you replied with
 * plain text" and it ran long again. Folding it into the shared runner fixes
 * that, and picks up the `name`-carrying tool messages the repair round needs.
 */
export async function generateCoursePayload(
  brief: CourseBrief,
  existingTitles: string[],
  deps?: GeneratorDeps,
): Promise<GeneratedCourse> {
  const resolved = deps ?? resolveGeneratorDeps();
  // Ground the outline in our own curriculum when RAG is configured (best-effort:
  // empty string when disabled or no match, so behavior is unchanged otherwise).
  const groundQuery = `${brief.objective} ${brief.titleHint ?? ""}`.trim();
  // Two independent lookups, so they run together: our curriculum (what to
  // teach and in what order) and the live web (what is current in this subject
  // today, which decides which chapters are still worth having at all).
  const [{ block: grounding, guides, count }, freshness] = await Promise.all([
    retrieveGroundingDetailed(groundQuery, { topK: 8 }),
    retrieveFreshness(brief.titleHint ?? brief.objective, {
      intent: "current version roadmap what to learn deprecated",
      label: "course-maker",
    }),
  ]);
  // eslint-disable-next-line no-console
  console.info(
    count > 0
      ? `[course-maker] outline grounded in knowledge base: ${count} chunks from ${guides.join(", ")}`
      : `[course-maker] outline: no knowledge-base grounding (RAG off or no match) for "${groundQuery.slice(0, 60)}"`,
  );
  return runForcedToolCall<GeneratedCourse>({
    deps: resolved,
    tool: emitCourseTool,
    system: buildCourseMakerSystemPrompt(existingTitles),
    user: buildCourseMakerUserMessage(brief, grounding, freshness),
    parse: (raw) => {
      const parsed = generatedCourseSchema.safeParse(raw);
      return parsed.success
        ? { success: true, data: parsed.data }
        : { success: false, issues: formatZodIssues(parsed.error) };
    },
    // Shorten the prose, never the curriculum — dropping chapters to fit a
    // token budget is exactly what the per-chapter split exists to prevent.
    sizeHint: "Keep every chapter, but cut each brief to two short sentences.",
    maxTokens: env.COURSE_MAX_OUTPUT_TOKENS,
    label: "Course generation",
  });
}
