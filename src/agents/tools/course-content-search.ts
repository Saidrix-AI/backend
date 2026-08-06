import { retrieveKnowledge, formatForModel, toSources } from "../../rag/retriever.js";
import { courseContentSearchTool, SEARCH_COURSE_CONTENT_TOOL_NAME } from "./prompts/course-content.js";
import type { RegisteredTool } from "./types.js";

export { SEARCH_COURSE_CONTENT_TOOL_NAME };

type Level = "beginner" | "intermediate" | "advanced";
function asLevel(v: unknown): Level | undefined {
  return v === "beginner" || v === "intermediate" || v === "advanced" ? v : undefined;
}

/**
 * RAG over the Saidrix curriculum. Mirrors the web-search tool: retrieve →
 * format for the model → emit sources for the chat UI's citation strip. Not
 * user-scoped (the curriculum is shared), so it's available even to logged-out
 * chat. Never throws — failures become an ok:false outcome.
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
        sources: toSources(chunks),
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
