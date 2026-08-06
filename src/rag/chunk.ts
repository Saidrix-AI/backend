import { createHash } from "node:crypto";

/**
 * Heading-aware splitter for the Course-Content curriculum files. Every file
 * follows the same deep template (H1 title + metadata blockquote, then `## `
 * sections including the 🟢/🟡/🔴 level blocks, each with `### ` module
 * sub-sections), so we split on headings and keep rich metadata on each chunk.
 */

export type Level = "overview" | "beginner" | "intermediate" | "advanced";

export interface ChunkMeta {
  skill: string;
  category: string;
  categoryNumber: number;
  level: Level;
  section: string;
  sourcePath: string;
  chunkIndex: number;
}

export interface Chunk extends ChunkMeta {
  text: string;
}

// ~4 chars/token: 2800 ≈ 700 tokens per chunk, small overlap for context bleed.
const MAX_CHARS = 2800;
const OVERLAP_CHARS = 160;

function categoryFromPath(sourcePath: string): { category: string; categoryNumber: number } {
  // e.g. Course-Content/16-Emerging-and-Specialized/WebRTC/README.md
  const parts = sourcePath.split(/[\\/]/).filter(Boolean);
  const ccIdx = parts.lastIndexOf("Course-Content");
  const folder = ccIdx >= 0 ? (parts[ccIdx + 1] ?? "") : (parts[parts.length - 3] ?? "");
  const m = folder.match(/^(\d+)-(.+)$/);
  const categoryNumber = m ? Number.parseInt(m[1]!, 10) : 0;
  const category = (m ? m[2]! : folder).replace(/-/g, " ").trim();
  return { category, categoryNumber };
}

function skillFromMarkdown(markdown: string, sourcePath: string): string {
  const h1 = markdown.split(/\r?\n/).find((l) => l.startsWith("# "));
  if (h1) {
    return h1
      .replace(/^#\s+/, "")
      .replace(/\s*[—-]\s*Complete Course\s*$/i, "")
      .trim();
  }
  const parts = sourcePath.split(/[\\/]/).filter(Boolean);
  return (parts[parts.length - 2] ?? "Unknown").replace(/-/g, " ");
}

function levelOf(heading: string): Level {
  if (/🟢|beginner/i.test(heading)) return "beginner";
  if (/🟡|intermediate/i.test(heading)) return "intermediate";
  if (/🔴|advanced/i.test(heading)) return "advanced";
  return "overview";
}

function hardSplit(text: string): string[] {
  const out: string[] = [];
  const step = MAX_CHARS - OVERLAP_CHARS;
  for (let i = 0; i < text.length; i += step) out.push(text.slice(i, i + MAX_CHARS));
  return out;
}

/** Splits one section's body into <= MAX_CHARS pieces on paragraph boundaries. */
function splitBody(body: string): string[] {
  if (body.length <= MAX_CHARS) return [body];
  const paras = body.split(/\n{2,}/);
  const pieces: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > MAX_CHARS) {
      pieces.push(cur.trim());
      cur = `${cur.slice(-OVERLAP_CHARS)}\n\n${p}`; // carry a little context forward
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur.trim()) pieces.push(cur.trim());
  return pieces.flatMap((c) => (c.length <= MAX_CHARS * 1.5 ? [c] : hardSplit(c)));
}

/**
 * Chunks one curriculum markdown file. `sourcePath` should be a stable,
 * repo-relative path (used both as metadata and to derive the id in ingestion).
 */
export function chunkFile(markdown: string, sourcePath: string): Chunk[] {
  const { category, categoryNumber } = categoryFromPath(sourcePath);
  const skill = skillFromMarkdown(markdown, sourcePath);

  const segments: { section: string; level: Level; body: string }[] = [];
  let currentLevel: Level = "overview";
  let section = "Intro";
  let buf: string[] = [];

  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) segments.push({ section, level: currentLevel, body });
    buf = [];
  };

  for (const line of markdown.split(/\r?\n/)) {
    const h2 = line.match(/^##\s+(.*)$/);
    const h3 = line.match(/^###\s+(.*)$/);
    if (h2) {
      flush();
      currentLevel = levelOf(h2[1]!); // H2 sets the sticky level for its H3s
      section = h2[1]!.trim();
      buf.push(line);
    } else if (h3) {
      flush();
      section = h3[1]!.trim();
      buf.push(line);
    } else {
      buf.push(line);
    }
  }
  flush();

  const chunks: Chunk[] = [];
  let idx = 0;
  for (const seg of segments) {
    for (const text of splitBody(seg.body)) {
      chunks.push({
        skill,
        category,
        categoryNumber,
        level: seg.level,
        section: seg.section,
        sourcePath,
        chunkIndex: idx++,
        text,
      });
    }
  }
  return chunks;
}

/** Stable id for a chunk (path + position) so re-ingesting is idempotent. */
export function chunkId(c: Chunk): string {
  return `${c.sourcePath}#${c.chunkIndex}`;
}

/** Content hash so ingestion can skip chunks whose text hasn't changed. */
export function chunkHash(c: Chunk): string {
  return createHash("sha1").update(c.text).digest("hex");
}

/** Text actually sent to the embeddings model — prefixed with skill/section for recall. */
export function embeddingText(c: Chunk): string {
  return `${c.skill} · ${c.section} (${c.level})\n\n${c.text}`;
}
