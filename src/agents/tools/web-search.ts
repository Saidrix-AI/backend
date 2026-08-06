import { env } from "../../config/env.js";
import { webSearchTool } from "./prompts/web-search.js";

/**
 * OpenAI-compatible tool schema for web search (prompt in ./prompts/web-search.ts).
 * Agents pass this in the `tools` array so the model can decide to search.
 */
export const webSearchToolSchema = webSearchTool;

export const WEB_SEARCH_TOOL_NAME = "web_search";

export interface SearchSource {
  title: string;
  url: string;
  content?: string;
}

export interface WebSearchResult {
  query: string;
  answer?: string;
  sources: SearchSource[];
}

export interface WebSearchOptions {
  /** Results to return. Defaults to 5. */
  maxResults?: number;
  /** Tavily search depth. "advanced" costs more and is slower. */
  searchDepth?: "basic" | "advanced";
  /**
   * Restrict to results published within this window. Used by the freshness
   * layer to bias generation towards current material; the chat tool leaves it
   * unset, because a general question is often best answered by an old page.
   */
  timeRange?: "day" | "week" | "month" | "year";
  /** Domains to exclude, e.g. content farms that outrank primary sources. */
  excludeDomains?: string[];
  /**
   * Restrict results to these domains. The lecture resources step uses it for a
   * YouTube-only pass, so the video slot cannot be filled by a blog post.
   */
  includeDomains?: string[];
}

/** Runs a Tavily web search. Throws if TAVILY_API_KEY is not configured. */
export async function runWebSearch(query: string, opts: WebSearchOptions = {}): Promise<WebSearchResult> {
  if (!env.TAVILY_API_KEY) {
    throw new Error("TAVILY_API_KEY is not configured");
  }

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query,
      max_results: opts.maxResults ?? 5,
      search_depth: opts.searchDepth ?? "basic",
      include_answer: true,
      ...(opts.timeRange ? { time_range: opts.timeRange } : {}),
      ...(opts.excludeDomains?.length ? { exclude_domains: opts.excludeDomains } : {}),
      ...(opts.includeDomains?.length ? { include_domains: opts.includeDomains } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tavily search failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    answer?: string;
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  const sources: SearchSource[] = (data.results ?? []).map((r) => ({
    title: r.title ?? r.url ?? "Untitled",
    url: r.url ?? "",
    content: r.content,
  }));

  return { query, answer: data.answer, sources };
}

/** Compact text block fed back to the model as the tool result. */
export function formatSearchForModel(result: WebSearchResult): string {
  const lines: string[] = [];
  if (result.answer) lines.push(`Summary: ${result.answer}`, "");
  result.sources.forEach((s, i) => {
    lines.push(`[${i + 1}] ${s.title} (${s.url})`);
    if (s.content) lines.push(s.content.slice(0, 500));
    lines.push("");
  });
  return lines.join("\n").trim() || "No results found.";
}
