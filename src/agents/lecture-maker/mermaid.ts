import { env } from "../../config/env.js";
import { parseMermaidCodes } from "./browser.js";
import { MAX_REVEALABLE_NODES, nodeKeyBlocker, revealBlocker } from "./revealable.js";
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
// `"` too: a quote inside a bare label (`C[charset="UTF-8" নির্দেশ]`) is a parse
// error, and cost a live class its diagram (block b13, 2026-09-29). Quoting the
// label turns the inner quotes into single quotes, which render as written.
const NEEDS_QUOTING = /[(){}[\]<>|;"]/;

// A double-quoted label, allowing the backslash-escaped quote a model writes
// when it is thinking in JSON. Everything outside is structure and untouched.
const QUOTED_LABEL = /"((?:\\"|[^"\n])*)"/g;

/**
 * Makes quoted label TEXT render as written. Measured on Mermaid 11.16 in
 * Chromium after a live HTML class failed to draw (2026-09-29): `\"` inside a
 * label is a parse error and `#quot;` renders as the literal "&quot;", while a
 * single quote renders as written; raw `<head>` parses but strict mode silently
 * deletes it, while `#lt;`/`#gt;` render as `<`/`>`. Mirrors
 * normalizeMermaidLabels in frontend/src/lib/mermaid.js, which applies the same
 * rewrite at render time for diagrams stored before this existed.
 */
function normalizeLabels(code: string): string {
  return code.replace(
    QUOTED_LABEL,
    (_m, label: string) => `"${label.replace(/\\"/g, "'").replace(/</g, "#lt;").replace(/>/g, "#gt;")}"`,
  );
}

export function fixMermaidCode(code: string): string {
  const quote = (id: string, open: string, close: string, label: string) => {
    const trimmed = label.trim();
    if (!trimmed || (trimmed.startsWith('"') && trimmed.endsWith('"'))) return `${id}${open}${label}${close}`;
    if (!NEEDS_QUOTING.test(trimmed)) return `${id}${open}${label}${close}`;
    return `${id}${open}"${trimmed.replace(/"/g, "'")}"${close}`;
  };
  const quoted = code
    .replace(/(\b[\w-]+)\[([^\][\n]*)\]/g, (_m, id: string, label: string) => quote(id, "[", "]", label))
    .replace(/(\b[\w-]+)\{([^{}\n]*)\}/g, (_m, id: string, label: string) => quote(id, "{", "}", label));
  // After quoting, so a label this function just quoted is escaped too.
  return normalizeLabels(quoted);
}

/**
 * Generation-time gate on Mermaid blocks emitted by the topic worker.
 *
 * Two checks, with deliberately different severities.
 *
 * SYNTAX is hard. Mermaid renders in the student's browser, so a parse error
 * would surface as an error card in the finished lecture. That is sent back for
 * repair every time, exactly as before.
 *
 * STRUCTURE is soft, and only asked once. The live tutor can build a flowchart
 * up part by part in front of a student, and cannot do that with any other
 * diagram kind, with more than eight nodes, or with node names it cannot put in
 * a DOM id (see revealable.ts). Those are worth one nudge — but a diagram that
 * fails them is still a perfectly good diagram, and the fallback is simply that
 * the tutor shows it whole and talks through it. Costing a lecture its whole
 * topic over an animation that would have been nice is the wrong trade, and
 * `isFinal` is how the caller says the next failure is the expensive one.
 *
 * Returns null when everything passes, when checking is off, or when the
 * browser is unavailable (accept-and-lean-on-the-frontend-fallback).
 */
export async function checkMermaidBlocks(
  blocks: EasyBlock[],
  opts: { isFinal?: boolean } = {},
): Promise<string | null> {
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

  const structural = (code: string, blocker: string) => {
    const snippet = code.slice(0, 60).replace(/\s+/g, " ");
    return (
      `The diagram "${snippet}…" cannot be drawn part by part during the class: ${blocker}. ` +
      `Rewrite it as a flowchart with at most ${MAX_REVEALABLE_NODES} nodes and short English ` +
      `node names — or, if this idea genuinely needs a different diagram kind, leave it as it is.`
    );
  };

  // The source-only half of the reveal check runs FIRST, before any browser is
  // touched. It reads the diagram kind and the banned directives out of the
  // text, so it needs nothing — and putting it after the parse call would have
  // meant that on a deployment with LECTURE_SVG_RENDER_ENABLED=false (a
  // supported, documented configuration) the whole gate silently did nothing.
  if (!opts.isFinal) {
    for (const b of mermaids) {
      const blocker = revealBlocker(b.code);
      if (blocker) return structural(b.code, blocker);
    }
  }

  const results = await parseMermaidCodes(mermaids.map((b) => b.code));
  if (!results) {
    // Still accepted — a missing browser must not sink a lecture, and the
    // frontend normalizes labels at render time. But said out loud every time:
    // this returning null quietly is how the gate stayed off for weeks.
    if (env.LECTURE_SVG_RENDER_ENABLED) {
      console.warn(
        `[lecture-maker] ${mermaids.length} Mermaid diagram(s) shipped WITHOUT a syntax check — no browser available`,
      );
    }
    return null;
  }

  const badIndex = results.findIndex((r) => r !== null);
  if (badIndex !== -1) {
    const snippet = mermaids[badIndex]!.code.slice(0, 60).replace(/\s+/g, " ");
    return `Mermaid diagram "${snippet}…" has invalid syntax: ${results[badIndex]}. Fix the Mermaid code so it parses.`;
  }

  // The half that needs a real render: the node keys and how many there are.
  // Advisory on top of the above, never instead of it.
  if (opts.isFinal) return null;
  for (const b of mermaids) {
    const blocker = await nodeKeyBlocker(b.code);
    if (blocker) return structural(b.code, blocker);
  }
  return null;
}
