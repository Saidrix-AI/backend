import { resolveLectureDeps, runForcedToolCall, type LlmDeps } from "./call.js";
import { buildClassifierSystemPrompt, buildClassifierUserMessage, type LessonContext } from "./prompt.js";
import { emitLessonKindTool, lessonKindSchema, type LessonKind } from "./schema.js";

/**
 * Which lane this lesson goes down: the concept lecture, or the setup guide.
 *
 * Decided by a model rather than by keywords on the title. Courses are generated
 * in the student's own language — a Bangla course's setup lesson is not called
 * "Install", and a keyword list would silently route every one of them to the
 * wrong lane. It reads the curriculum's own instruction for the lesson, which is
 * where the real signal is.
 *
 * FAIL-OPEN. Any error, timeout or unparseable answer returns "concept", which
 * is exactly the behaviour this codebase had before the setup lane existed. A
 * classifier outage must degrade the two setup lessons in a course, never take
 * the other fifty down with them.
 *
 * Cheap by construction: ~120 output tokens on the default model, and index.ts
 * runs it alongside the RAG and freshness retrievals, so it costs no wall clock.
 */
export async function classifyLesson(ctx: LessonContext, deps?: LlmDeps): Promise<LessonKind> {
  try {
    const result = await runForcedToolCall({
      deps: deps ?? resolveLectureDeps("classifier"),
      tool: emitLessonKindTool,
      system: buildClassifierSystemPrompt(),
      user: buildClassifierUserMessage(ctx),
      parse: (raw) => {
        const r = lessonKindSchema.safeParse(raw);
        return r.success
          ? { success: true as const, data: r.data }
          : { success: false as const, issues: 'answer with kind: "concept" or "setup"' };
      },
      sizeHint: "Answer with the kind and one short sentence.",
      maxTokens: 120,
    });
    if (result.kind === "setup") {
      console.info(`[lecture-maker] "${ctx.topicTitle}" → setup lane (${result.reason || "no reason given"})`);
    }
    return result.kind;
  } catch (err) {
    console.warn(
      `[lecture-maker] lesson classification failed for "${ctx.topicTitle}", defaulting to concept:`,
      err instanceof Error ? err.message : err,
    );
    return "concept";
  }
}
