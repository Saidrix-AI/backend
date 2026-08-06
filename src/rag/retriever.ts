import { isRagEnabled, ragConfig } from "../config/env.js";
import type { SearchSource } from "../agents/tools/web-search.js";
import { embedOne } from "./embeddings.js";
import { queryVectors } from "./pinecone.js";
import type { Level } from "./chunk.js";

/** High-level retrieval over the curriculum knowledge base. */

export interface RetrievedChunk {
  skill: string;
  category: string;
  level: string;
  section: string;
  sourcePath: string;
  text: string;
  score: number;
}

export interface RetrieveOptions {
  topK?: number;
  level?: Exclude<Level, "overview">;
  category?: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Embeds the query and returns the top curriculum chunks. Best-effort: returns
 * `[]` (never throws) when RAG is disabled, the query is empty, or anything
 * fails — callers treat an empty result as "no grounding available".
 */
export async function retrieveKnowledge(
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  if (!isRagEnabled() || !query.trim()) return [];
  try {
    const vector = await embedOne(query);
    const filter: Record<string, unknown> = {};
    if (opts.level) filter.level = opts.level;
    if (opts.category) filter.category = opts.category;

    const matches = await queryVectors(
      vector,
      opts.topK ?? ragConfig.topK,
      Object.keys(filter).length ? filter : undefined,
    );

    return matches
      .map((m) => ({
        skill: str(m.metadata.skill),
        category: str(m.metadata.category),
        level: str(m.metadata.level),
        section: str(m.metadata.section),
        sourcePath: str(m.metadata.sourcePath),
        text: str(m.metadata.text),
        score: m.score,
      }))
      .filter((c) => c.text);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[rag] retrieval failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** Cited block fed back to the chat model as the tool result. */
export function formatForModel(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "No matching curriculum sections found.";
  return chunks
    .map((c, i) => `[${i + 1}] ${c.skill} — ${c.section} (${c.level})\n${c.text.trim()}`)
    .join("\n\n");
}

/** Maps chunks to the existing SearchSource shape so the chat UI cites them for free. */
export function toSources(chunks: RetrievedChunk[]): SearchSource[] {
  return chunks.map((c) => ({
    title: `${c.skill} — ${c.section}`,
    url: c.sourcePath,
    content: c.text.slice(0, 300),
  }));
}

/** Formats retrieved chunks into the reference block injected into generation prompts. */
function formatGroundingBlock(chunks: RetrievedChunk[]): string {
  const body = chunks
    .map((c) => `- ${c.skill} · ${c.section}: ${c.text.replace(/\s+/g, " ").slice(0, 600)}`)
    .join("\n");
  return (
    "Reference material from the Saidrix curriculum (align your terminology, roadmap and depth " +
    `with this; do not contradict it):\n${body}`
  );
}

/**
 * Grounding block + the distinct curriculum guides it drew on + hit count.
 * Lets the caller log/surface exactly which knowledge-base material was used.
 */
export async function retrieveGroundingDetailed(
  query: string,
  opts: RetrieveOptions = {},
): Promise<{ block: string; guides: string[]; count: number }> {
  const chunks = await retrieveKnowledge(query, opts);
  const guides = [...new Set(chunks.map((c) => c.skill))].filter(Boolean);
  return { block: chunks.length ? formatGroundingBlock(chunks) : "", guides, count: chunks.length };
}

/**
 * Compact reference block appended to generation-agent prompts (course-maker,
 * lecture-maker). Empty string when RAG is off or nothing matches, so callers
 * can concatenate unconditionally with no behavior change.
 */
export async function retrieveGrounding(query: string, opts: RetrieveOptions = {}): Promise<string> {
  const { block } = await retrieveGroundingDetailed(query, opts);
  return block;
}
