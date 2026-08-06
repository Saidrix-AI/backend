import {
  WEB_SEARCH_TOOL_NAME,
  webSearchToolSchema,
  runWebSearch,
  formatSearchForModel,
} from "./web-search.js";
import { courseContentSearchToolDef, SEARCH_COURSE_CONTENT_TOOL_NAME } from "./course-content-search.js";
import { isRagEnabled } from "../../config/env.js";
import { studentTools } from "./student-tools.js";
import { courseTools } from "./course-tools.js";
import { courseMakerTools } from "./course-maker-tools.js";
import { projectTools } from "./project-tools.js";
import { routineTools } from "./routine-tools.js";
import { questionTools } from "./question-tools.js";
import { intakeTools } from "./intake-tools.js";
import type { RegisteredTool } from "./types.js";

const webSearchTool: RegisteredTool = {
  schema: webSearchToolSchema,
  runningLabel: () => "Searching the web",
  run: async (_ctx, args) => {
    const query = typeof args.query === "string" ? args.query : "";
    try {
      const result = await runWebSearch(query);
      return {
        ok: true,
        label: "Web search complete",
        modelText: formatSearchForModel(result),
        sources: result.sources,
      };
    } catch (err) {
      return {
        ok: false,
        label: "Web search failed",
        modelText: `Search failed: ${err instanceof Error ? err.message : "unknown error"}`,
      };
    }
  },
};

// start_knowledge_check is deliberately absent: the knowledge check now runs as
// the third stage of the guided intake (start_learning_intake), and offering
// both left the model choosing between two overlapping flows.
const DB_TOOLS = [
  ...studentTools,
  ...courseTools,
  ...courseMakerTools,
  ...projectTools,
  ...routineTools,
  ...questionTools,
  ...intakeTools,
];

/**
 * Tools available for this request. DB tools operate on the caller's own data
 * and therefore require an authenticated userId; web search needs Tavily.
 */
export function buildToolset(opts: {
  userId?: string;
  searchEnabled: boolean;
}): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  if (opts.searchEnabled) tools.set(WEB_SEARCH_TOOL_NAME, webSearchTool);
  // The curriculum is shared, not per-user, so it's offered even to anonymous
  // chat — gated only on the RAG layer being configured.
  if (isRagEnabled()) tools.set(SEARCH_COURSE_CONTENT_TOOL_NAME, courseContentSearchToolDef);
  if (opts.userId) {
    for (const t of DB_TOOLS) tools.set(t.schema.function.name, t);
  }
  return tools;
}
