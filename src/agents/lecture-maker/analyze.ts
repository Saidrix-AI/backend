import { formatZodIssues, resolveLectureDeps, runForcedToolCall, type LlmDeps } from "./call.js";
import { retrieveGrounding } from "../../rag/retriever.js";
import { retrieveFreshness } from "../shared/freshness.js";
import {
  buildAnalystSystemPrompt,
  buildAnalystUserMessage,
  buildSetupAnalystSystemPrompt,
  buildSetupAnalystUserMessage,
  type LessonContext,
} from "./prompt.js";
import {
  emitLessonBlueprintTool,
  emitSetupBlueprintTool,
  lessonBlueprintSchema,
  setupBlueprintSchema,
  type LessonBlueprint,
  type SetupBlueprint,
} from "./schema.js";

/**
 * The two groundings every lecture is built on, whichever lane it takes.
 *
 * They live outside the analyst call so index.ts can start them at the same time
 * as the lesson classifier — the classifier has to finish before we know WHICH
 * analyst to run, and hiding it inside this wait is what keeps it free.
 *
 * The pipeline still makes exactly one embedding call and exactly one web search
 * per lecture, however many topic writers it later fans out to.
 */
export async function retrieveLessonGrounding(
  ctx: LessonContext,
): Promise<{ grounding: string; freshness: string }> {
  // The brief's opening names the concepts this lesson covers, which retrieves
  // better than the title alone; it is truncated because a long query dilutes
  // embedding similarity and starts matching the sibling lessons the brief
  // exists to exclude.
  const query = `${ctx.topicTitle} ${ctx.courseTitle} ${(ctx.topicBrief ?? "").slice(0, 200)}`.trim();
  // The web query is deliberately NOT the same string: search engines want the
  // subject, not the whole curriculum instruction, and the course title is what
  // disambiguates a lesson title like "State" into a searchable subject.
  const [grounding, freshness] = await Promise.all([
    retrieveGrounding(query, { topK: 5 }),
    retrieveFreshness(`${ctx.courseTitle} ${ctx.topicTitle}`, {
      intent: "current version syntax deprecations best practices",
      label: "lecture-maker",
    }),
  ]);
  return { grounding, freshness };
}

/**
 * One analyst call, before anything is planned: lesson context → what this
 * lesson actually teaches, which concepts it is made of and in what order, the
 * worked examples the whole lecture will share, and where a picture genuinely
 * helps. Everything downstream reads this instead of re-deriving the lesson
 * from its title.
 *
 * The analyst is the ONLY call that sees the raw search results; the blueprint
 * carries them forward digested (as `currency`).
 */
export async function buildLessonBlueprint(
  ctx: LessonContext,
  grounding = "",
  freshness = "",
  deps?: LlmDeps,
): Promise<LessonBlueprint> {
  return runForcedToolCall({
    deps: deps ?? resolveLectureDeps("analyst"),
    tool: emitLessonBlueprintTool,
    system: buildAnalystSystemPrompt(),
    user: buildAnalystUserMessage(ctx, grounding, freshness),
    parse: (raw) => {
      const r = lessonBlueprintSchema.safeParse(raw);
      return r.success
        ? { success: true, data: r.data }
        : { success: false, issues: formatZodIssues(r.error) };
    },
    // The blueprint is short by construction, so truncation means the model
    // padded rather than that the lesson is large. Cut the prose, not the
    // concept list — dropping concepts would silently shrink the lecture.
    sizeHint:
      "Keep every concept, example and currency line, but write each field in one short sentence.",
  });
}

/**
 * The setup lane's analyst: same position in the pipeline, different reading.
 * Nothing here is a concept to be understood — it is a machine to be changed —
 * so it produces the tools, prerequisites, stages, verification commands and
 * real failure modes an install guide is assembled from.
 */
export async function buildSetupBlueprint(
  ctx: LessonContext,
  grounding = "",
  freshness = "",
  deps?: LlmDeps,
): Promise<SetupBlueprint> {
  return runForcedToolCall({
    deps: deps ?? resolveLectureDeps("analyst"),
    tool: emitSetupBlueprintTool,
    system: buildSetupAnalystSystemPrompt(),
    user: buildSetupAnalystUserMessage(ctx, grounding, freshness),
    parse: (raw) => {
      const r = setupBlueprintSchema.safeParse(raw);
      if (r.success) return { success: true, data: r.data };
      const issues = formatZodIssues(r.error);
      console.warn(`[lecture-maker] setup blueprint rejected: ${issues}`);
      return { success: false, issues };
    },
    // The pitfalls and verification lists are the two things a repair round must
    // not quietly drop — the troubleshooting table and the closing checklist are
    // built verbatim out of them.
    sizeHint:
      "Keep every tool, stage, verification, pitfall and currency line, but write each field in one short sentence.",
  });
}
