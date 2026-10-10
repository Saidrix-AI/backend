import { outlineMermaid } from "./browser.js";

/**
 * Can the live tutor build this diagram up part by part in front of a student?
 *
 * ⚠️ `voice-service/app/mermaid_plan.py` IS THE AUTHORITY. This file is the
 * generation-time mirror of it, written in a different language, in a different
 * service, and it WILL drift. What makes that dangerous is how quietly it
 * fails: a diagram that passes here and is refused there is not a broken
 * lecture — the tutor simply shows it whole and talks through it, which is a
 * designed and perfectly acceptable outcome. So drift costs a feature silently
 * rather than breaking anything loudly. If you change a rule in either file,
 * change it in both, and prefer the E2E check that runs a generated diagram
 * through the PYTHON gate over trusting this one.
 *
 * The rules are not stylistic. Each removes a case the reveal cannot express:
 *   flowchart only   every other diagram type has its own DOM id scheme, and
 *                    the reveal targeting was verified against flowchart's.
 *   ≤ 8 nodes        a bigger diagram does not fit the pane, and a reveal plan
 *                    over it stops being a walkthrough.
 *   ASCII keys       keys become DOM ids and the parts of an `L_from_to_n` edge
 *                    id. Labels stay in the lecture's language; keys do not.
 *   no subgraph      clusters render without the `-flowchart-` id segment, so a
 *                    reveal naming one silently does nothing at all.
 *
 * A diagram that fails is still a good diagram — it just cannot be animated.
 */

/** Mirrors MAX_NODES in mermaid_plan.py. */
export const MAX_REVEALABLE_NODES = 8;

const HEADER = /^\s*(?:flowchart|graph)\s+(?:TD|TB|LR|RL|BT)\s*$/i;
const VALID_KEY = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * Directives the reveal cannot express, and `--o` / `--x`, whose stray `o`/`x`
 * the Python parser cannot tell from a real one-letter node key.
 */
const BANNED: [RegExp, string][] = [
  [/^\s*subgraph\b/im, "subgraphs cannot be revealed part by part"],
  [/^\s*click\b/im, "click directives are not allowed"],
  [/^\s*classDef\b/im, "classDef is not supported"],
  [/^\s*linkStyle\b/im, "linkStyle is not supported"],
  [/^\s*style\b/im, "style directives are not supported"],
  [/-{2,}[ox]\s/, "--o and --x links are not supported; use -->"],
];

/**
 * Strips label text so the syntax checks below never read a label's contents as
 * structure. Tracked by depth rather than by regex because a label can legally
 * contain the very syntax being looked for: `A["Client --> DB"]` is one node.
 */
function stripLabels(code: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (const ch of code) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (ch === "[" || ch === "(" || ch === "{") depth++;
    else if (ch === "]" || ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

/**
 * A structural reason this diagram cannot be revealed, or null.
 *
 * Cheap and synchronous — no browser. Everything here is decidable from the
 * source text; `nodeKeysFrom` below is the part that needs a real renderer.
 */
export function revealBlocker(code: string): string | null {
  const source = String(code || "");
  const firstLine = source.split("\n").find((l) => l.trim().length > 0) ?? "";
  if (!HEADER.test(firstLine)) {
    return (
      `it starts with "${firstLine.trim().slice(0, 40)}". Only a flowchart can be ` +
      `drawn part by part — write "flowchart TD" unless the idea genuinely needs another kind`
    );
  }

  const bare = stripLabels(source);
  for (const [pattern, why] of BANNED) {
    if (pattern.test(bare)) return why;
  }
  // A user-defined edge id (`A e1@--> B`) replaces the from/to scheme the
  // reveal derives edge visibility from.
  if (/@\s*-{2,}|@\s*={2,}/.test(bare)) return "custom edge ids (the @ syntax) are not supported";

  return null;
}

/**
 * The half that needs a renderer: the node keys Mermaid actually emitted.
 *
 * Checked against what was rendered rather than against a regex's reading of
 * the source, because the ids are what the reveal targets. Returns null when
 * the renderer could not answer — this is an advisory gate on top of the
 * synchronous one, never a replacement for it.
 */
export async function nodeKeyBlocker(code: string): Promise<string | null> {
  const outline = await outlineMermaid(code, { live: false });
  if (!outline) return null; // rendering off, no browser, or it failed — say nothing
  if (!outline.diagramType.startsWith("flowchart")) return null; // revealBlocker's job
  // A successful render with no keys means the id scheme moved, not that the
  // diagram is empty. Never turn that into a rejection.
  if (outline.nodeKeys.length === 0) return null;

  if (outline.nodeKeys.length > MAX_REVEALABLE_NODES) {
    return (
      `it has ${outline.nodeKeys.length} nodes. Keep it to ${MAX_REVEALABLE_NODES} ` +
      `so it can be drawn part by part and still fit beside the lecture`
    );
  }
  const bad = outline.nodeKeys.find((k) => !VALID_KEY.test(k));
  if (bad) {
    return (
      `the node name "${bad}" is not usable. Node names are identifiers the student ` +
      `never sees — use short English letters and digits only, no underscores and no ` +
      `other scripts. Put the visible words in the label instead`
    );
  }
  return null;
}
