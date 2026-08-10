import { retrieveKnowledge, formatForModel } from "../../rag/retriever.js";
import { courseContentSearchTool, SEARCH_COURSE_CONTENT_TOOL_NAME } from "./prompts/course-content.js";
import type { RegisteredTool } from "./types.js";

export { SEARCH_COURSE_CONTENT_TOOL_NAME };

type Level = "beginner" | "intermediate" | "advanced";
function asLevel(v: unknown): Level | undefined {
  return v === "beginner" || v === "intermediate" || v === "advanced" ? v : undefined;
}

/**
 * RAG over the Saidrix curriculum. Not user-scoped (the curriculum is shared),
 * so it's available even to logged-out chat. Never throws — failures become an
 * ok:false outcome.
 *
 * Deliberately emits NO `sources`, unlike the web-search tool it was modelled
 * on. Curriculum hits are internal file paths, not pages a student can open, so
 * the citation strip listed six unclickable guide names under every answer —
 * plumbing, not information. The retrieval still reaches the model through
 * `modelText`, and the prompt asks it to credit the guide in prose ("from our
 * React guide"), which is the useful half. The activity chips are suppressed
 * alongside it: see the SEARCH_COURSE_CONTENT_TOOL_NAME checks in
 * services/chat.service.ts and the Chat page.
 */
export const courseContentSearchToolDef: RegisteredTool = {
  schema: courseContentSearchTool,
  runningLabel: () => "Searching the curriculum",
  run: async (_ctx, args) => {
    const query = typeof args.query === "string" ? args.query : "";
    const level = asLevel(args.level);
    const category = typeof args.category === "string" ? args.category : undefined;

    try {
      const chunks = await retrieveKnowledge(query, { level, category });
      if (chunks.length === 0) {
        return {
          ok: true,
          label: "No curriculum match",
          modelText:
            "No matching curriculum sections found. Answer from your own knowledge, or use web_search for current info.",
        };
      }
      return {
        ok: true,
        label: "Curriculum search complete",
        modelText: formatForModel(chunks),
      };
    } catch (err) {
      return {
        ok: false,
        label: "Curriculum search failed",
        modelText: `Curriculum search failed: ${err instanceof Error ? err.message : "unknown error"}`,
      };
    }
  },
};
