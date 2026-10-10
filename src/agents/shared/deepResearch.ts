import type OpenAI from "openai";
import { z } from "zod";
import { env } from "../../config/env.js";
import { getModelName, hasOpenAICompatProvider } from "../llm.js";
import type { SearchSource } from "../tools/web-search.js";
import { formatZodIssues, runForcedToolCall, type LlmDeps } from "./forcedToolCall.js";
import { retrieveFreshContext, today } from "./freshness.js";

/**
 * Research for a course that has no Saidrix curriculum template.
 *
 * One web search ("latest version best practices") was all such a course used
 * to get, so its structure came from the model's memory. This runs a few
 * searches that each answer a different question a curriculum designer asks,
 * then condenses the results into one brief the outline is written from.
 *
 * Never throws. Returns "" when web search is off or finds nothing, and the
 * raw results when the summary call fails.
 */

const INTENTS = [
  "complete syllabus what to learn in order",
  "learning roadmap beginner to job ready",
  "current tools versions and what is deprecated",
  "common beginner projects and practice exercises",
] as const;

const SNIPPET_CHARS = 700;

const briefSchema = z.object({ brief: z.string().trim().min(40).max(6000) });

const emitBriefTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_research_brief",
    description: "Emit the research brief. Call exactly once.",
    parameters: {
      type: "object",
      required: ["brief"],
      properties: {
        brief: {
          type: "string",
          description:
            "Plain text, under 500 words: the syllabus in teaching order, current tools and versions (only those the sources state), what is deprecated, and typical projects. Cite sources as [n].",
        },
      },
    },
  },
};

function resolveDeps(): LlmDeps | null {
  if (!hasOpenAICompatProvider()) return null;
  return { model: env.COURSE_MAKER_MODEL ?? getModelName() };
}

export async function deepResearch(topic: string, opts: { label?: string } = {}, deps?: LlmDeps): Promise<string> {
  if (!topic.trim()) return "";
  const label = opts.label ?? "deep-research";
  const results = await Promise.all(
    INTENTS.map((intent) => retrieveFreshContext(topic, { intent, maxResults: 4, label })),
  );

  const seen = new Set<string>();
  const sources: SearchSource[] = [];
  for (const r of results) {
    for (const s of r.sources) {
      const key = s.url || s.title;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(s);
    }
  }
  if (sources.length === 0) return "";

  const material = sources
    .slice(0, 14)
    .map(
      (s, i) =>
        `[${i + 1}] ${s.title}${s.url ? ` — ${s.url}` : ""}\n${(s.content ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS)}`,
    )
    .join("\n\n");
  const header =
    `RESEARCH BRIEF — live web research run today (${today()}) on "${topic}". ` +
    "Structure the course from this, not from memory; where it disagrees with your training data, it is correct.";

  const resolved = deps ?? resolveDeps();
  if (resolved) {
    try {
      const { brief } = await runForcedToolCall({
        deps: resolved,
        tool: emitBriefTool,
        system:
          "You are a curriculum researcher. Condense web search results into a factual brief a course designer will structure a course from. Use only what the sources say; never invent versions or dates.",
        user: `Topic: ${topic}\n\nSearch results:\n\n${material}`,
        parse: (raw) => {
          const r = briefSchema.safeParse(raw);
          return r.success ? { success: true, data: r.data } : { success: false, issues: formatZodIssues(r.error) };
        },
        sizeHint: "Keep the brief under 400 words.",
        maxTokens: 2000,
        label: "Deep research",
      });
      console.info(`[${label}] research brief for "${topic.slice(0, 60)}" from ${sources.length} source(s)`);
      return `${header}\n\n${brief}`;
    } catch (err) {
      console.warn(`[${label}] research summary failed, using raw results:`, err instanceof Error ? err.message : err);
    }
  }
  return `${header}\n\n${material}`;
}
