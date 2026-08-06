import { env, isFreshnessEnabled } from "../../config/env.js";
import { runWebSearch, type SearchSource } from "../tools/web-search.js";

/**
 * Live web grounding for the generation agents (course-maker, lecture-maker).
 *
 * WHY THIS IS NOT A TOOL THE MODEL CALLS: both agents run through
 * `runForcedToolCall`, which pins `tool_choice` to a single emit_* function and
 * has no agentic loop — the model physically cannot call a second tool. So the
 * search runs here, before the call, and its results are injected into the
 * prompt the same way `rag/retriever.ts` injects curriculum grounding. That is
 * also the stronger guarantee: every course and every lecture is written
 * against current material, instead of only the ones where a cheap model
 * happened to decide a search was worthwhile.
 *
 * The two grounding sources are complementary and both are injected:
 * - RAG  → our own curriculum: terminology, depth, roadmap shape.
 * - here → the outside world: current versions, deprecations, today's tooling.
 */

export interface FreshContext {
  /** Prompt-ready block; empty string when unavailable, so callers can concatenate blindly. */
  block: string;
  sources: SearchSource[];
  count: number;
}

const EMPTY: FreshContext = { block: "", sources: [], count: 0 };

/** Snippet budget per source. Long enough to carry a version number and its context. */
const SNIPPET_CHARS = 400;

interface CacheEntry {
  at: number;
  value: FreshContext;
}
const cache = new Map<string, CacheEntry>();

/** Exported for tests — a cached hit from a previous test would mask a regression. */
export function clearFreshnessCache(): void {
  cache.clear();
}

function cacheTtlMs(): number {
  return env.AGENT_FRESHNESS_CACHE_MINUTES * 60_000;
}

/** ISO date, used both in the query (recency bias) and in the prompt header. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Builds the search query. The year is appended because a bare topic query
 * ("React hooks") returns the canonical evergreen pages, which is exactly the
 * material the model already knows; the year is what surfaces the release
 * notes, migration guides and "what changed" posts this layer exists for.
 */
export function buildFreshnessQuery(topic: string, intent = "latest version best practices"): string {
  const year = new Date().getFullYear();
  // Long queries dilute search relevance the same way they dilute embeddings.
  const subject = topic.replace(/\s+/g, " ").trim().slice(0, 120);
  return `${subject} ${intent} ${year}`.trim();
}

function formatBlock(sources: SearchSource[], answer: string | undefined, query: string): string {
  const lines = [
    `CURRENT INFORMATION — live web search run today (${today()}) for "${query}".`,
    "Your training data is older than this. Where the two disagree, THIS IS CORRECT and your own",
    "memory is not. Teach the versions, syntax, tool names and practices shown here; if something",
    "below marks a technique, API or tool as deprecated, superseded or removed, do not teach it as",
    "current — teach its replacement and mention the old one only as history.",
    "Never state a version number, release date or 'as of' claim that is not supported below.",
    "If the results are thin or off-topic, teach the stable fundamentals instead of guessing — do",
    "NOT invent a version number to sound current.",
    "",
  ];
  if (answer) lines.push(`Summary: ${answer.replace(/\s+/g, " ").trim()}`, "");
  sources.forEach((s, i) => {
    lines.push(`[${i + 1}] ${s.title}${s.url ? ` — ${s.url}` : ""}`);
    if (s.content) lines.push(s.content.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS));
  });
  return lines.join("\n").trim();
}

export interface FreshnessOptions {
  /** What to look for beyond the topic itself. Defaults to versions + practices. */
  intent?: string;
  maxResults?: number;
  /** Restrict to recently published pages. Unset by default — see below. */
  timeRange?: "day" | "week" | "month" | "year";
  /** Label for the log line, e.g. "lecture-maker". */
  label?: string;
}

/**
 * Searches the web for what is current about `topic` and returns a prompt block.
 *
 * Best-effort in exactly the way `retrieveKnowledge` is: never throws, and
 * returns an empty block when the flag is off, no key is set, the query is
 * empty, or the request fails. A course must still generate when Tavily is down.
 *
 * No `timeRange` by default: a hard recency filter drops the canonical docs page
 * that states the current version, keeping only blog chatter about it. The year
 * in the query supplies the recency bias without discarding primary sources.
 */
export async function retrieveFreshContext(
  topic: string,
  opts: FreshnessOptions = {},
): Promise<FreshContext> {
  if (!isFreshnessEnabled() || !topic.trim()) return EMPTY;

  const query = buildFreshnessQuery(topic, opts.intent);
  const ttl = cacheTtlMs();
  const hit = ttl > 0 ? cache.get(query) : undefined;
  if (hit && Date.now() - hit.at < ttl) return hit.value;

  try {
    const res = await runWebSearch(query, {
      maxResults: opts.maxResults ?? env.AGENT_FRESHNESS_MAX_RESULTS,
      ...(opts.timeRange ? { timeRange: opts.timeRange } : {}),
    });
    const sources = res.sources.filter((s) => s.content?.trim());
    if (sources.length === 0 && !res.answer) return EMPTY;

    const value: FreshContext = {
      block: formatBlock(sources, res.answer, query),
      sources,
      count: sources.length,
    };
    if (ttl > 0) cache.set(query, { at: Date.now(), value });
    // eslint-disable-next-line no-console
    console.info(`[${opts.label ?? "freshness"}] web search "${query}" → ${sources.length} source(s)`);
    return value;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[${opts.label ?? "freshness"}] web search failed for "${query}":`,
      err instanceof Error ? err.message : err,
    );
    return EMPTY;
  }
}

/** Convenience for callers that only want the prompt block. */
export async function retrieveFreshness(topic: string, opts: FreshnessOptions = {}): Promise<string> {
  const { block } = await retrieveFreshContext(topic, opts);
  return block;
}
