import { parseMermaidCodes } from "./browser.js";
import type { EasyBlock } from "./schema.js";

/**
 * Node labels containing punctuation are the dominant Mermaid failure: the
 * model writes `B[range(start, stop)]`, and the parser reads the `(` as the
 * start of a different node shape. Mermaid's own answer is to quote the label,
 * and the model does not reliably do it however firmly the prompt asks — so, as
 * with fixSvg, the mistake is corrected in code rather than described back to a
 * cheap model and paid for with a repair round.
 *
 * Deliberately narrow: only `id[...]` and `id{...}` labels, only when they are
 * not already quoted and actually contain a character that breaks the parse.
 * Anything cleverer risks corrupting a diagram that would have parsed fine.
 */
const NEEDS_QUOTING = /[(){}[\]<>|;]/;

export function fixMermaidCode(code: string): string {
  const quote = (id: string, open: string, close: string, label: string) => {
    const trimmed = label.trim();
    if (!trimmed || (trimmed.startsWith('"') && trimmed.endsWith('"'))) return `${id}${open}${label}${close}`;
    if (!NEEDS_QUOTING.test(trimmed)) return `${id}${open}${label}${close}`;
    return `${id}${open}"${trimmed.replace(/"/g, "'")}"${close}`;
  };
  return code
    .replace(/(\b[\w-]+)\[([^\][\n]*)\]/g, (_m, id: string, label: string) => quote(id, "[", "]", label))
    .replace(/(\b[\w-]+)\{([^{}\n]*)\}/g, (_m, id: string, label: string) => quote(id, "{", "}", label));
}

/**
 * Generation-time gate on Mermaid blocks emitted by the topic worker.
 *
 * Mermaid renders in the student's browser, so a syntax error would surface as
 * an error card in the finished lecture. This checks the codes against a real
 * Mermaid parser first (via the Chromium harness) and, on failure, returns a
 * message the repair round can act on — the same contract validateSvgMarkup uses
 * for hand-drawn svg. Returns null when everything parses, checking is off, or
 * the browser is unavailable (accept-and-lean-on-the-frontend-fallback).
 */
export async function checkMermaidBlocks(blocks: EasyBlock[]): Promise<string | null> {
  const mermaids = blocks.filter(
    (b): b is EasyBlock & { code: string } => b.type === "mermaid" && typeof (b as { code?: unknown }).code === "string",
  );
  if (mermaids.length === 0) return null;

  // Repair before judging, so the code that gets validated is the code that
  // ships — and so a fixable label never costs a repair round.
  for (const b of mermaids) {
    const fixed = fixMermaidCode(b.code);
    if (fixed !== b.code) {
      console.debug(`[lecture-maker] auto-quoted mermaid label(s) in "${b.code.slice(0, 40).replace(/\s+/g, " ")}…"`);
      b.code = fixed;
    }
  }

  const results = await parseMermaidCodes(mermaids.map((b) => b.code));
  if (!results) return null;

  const badIndex = results.findIndex((r) => r !== null);
  if (badIndex === -1) return null;
  const snippet = mermaids[badIndex]!.code.slice(0, 60).replace(/\s+/g, " ");
  return `Mermaid diagram "${snippet}…" has invalid syntax: ${results[badIndex]}. Fix the Mermaid code so it parses.`;
}
