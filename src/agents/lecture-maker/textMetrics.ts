import {
  INTER_ADVANCES,
  INTER_ASCENT,
  INTER_DESCENT,
  INTER_FALLBACK_ADVANCE,
  INTER_MIDDLE_SHIFT,
  INTER_WEIGHTS,
} from "./interMetrics.js";
import type { Box } from "./svgParse.js";

/**
 * What a label is actually going to measure, without a browser.
 *
 * This replaces `content.length * fontSize * 0.55` — one flat ratio applied to
 * every glyph. In Inter a `W` advances 0.985em and an `i` 0.242em, so ten of
 * each measured identically under the old rule while really differing by more
 * than four times. Wide labels were therefore under-measured by nearly half
 * (and sailed past the overflow check that was supposed to catch them), and
 * narrow ones over-measured by more than double (and were "fixed" for problems
 * they never had).
 *
 * The browser is still preferred whenever it is available; this is the fallback
 * and the cross-check. Summing advances ignores kerning, so a long label drifts
 * by up to about a percent — small, but the reason collision rules allow more
 * slack on a metrics measurement than on a browser one.
 */

export const DEFAULT_FONT_WEIGHT = 400;

function snapWeight(weight: number): number {
  let best = INTER_WEIGHTS[0] as number;
  for (const w of INTER_WEIGHTS) {
    if (Math.abs(w - weight) < Math.abs(best - weight)) best = w;
  }
  return best;
}

/** Advance width of a label, in user units. */
export function measureText(content: string, fontSize: number, weight = DEFAULT_FONT_WEIGHT): number {
  const w = snapWeight(weight);
  const table = INTER_ADVANCES[w] ?? INTER_ADVANCES[DEFAULT_FONT_WEIGHT]!;
  const fallback = INTER_FALLBACK_ADVANCE[w] ?? 0.5;
  let em = 0;
  // Iterating the string (not indexing it) keeps astral characters — an emoji
  // in a label — as one unit rather than two half-measured surrogates.
  for (const ch of content) em += table[ch] ?? fallback;
  return em * fontSize;
}

/** Left edge of a label once its text-anchor is applied. */
export function labelLeft(x: number, width: number, anchor: string | null | undefined): number {
  if (anchor === "middle") return x - width / 2;
  if (anchor === "end") return x - width;
  return x;
}

export interface TextBoxInput {
  x: number;
  /** The baseline, before dominant-baseline is applied. */
  y: number;
  content: string;
  fontSize: number;
  anchor?: string | null;
  dominantBaseline?: string | null;
  weight?: number;
}

/**
 * The inked box of a label, matching what `getBBox()` reports in the browser.
 *
 * The vertical constants come from a real Chromium render (see
 * scripts/gen-font-metrics.ts) rather than from em-square arithmetic, including
 * the shift `dominant-baseline="middle"` applies — an attribute the diagram
 * prompt requires on everything centred inside a shape, so getting it wrong
 * would mis-place the majority of labels in a typical drawing.
 */
export function textInkBox(input: TextBoxInput): Box {
  const { x, y, content, fontSize, anchor, dominantBaseline, weight } = input;
  const width = measureText(content, fontSize, weight ?? DEFAULT_FONT_WEIGHT);
  const left = labelLeft(x, width, anchor);

  let top = y - INTER_ASCENT * fontSize;
  let bottom = y + INTER_DESCENT * fontSize;
  if (dominantBaseline === "middle" || dominantBaseline === "central") {
    const shift = INTER_MIDDLE_SHIFT * fontSize;
    top += shift;
    bottom += shift;
  }

  return { minX: left, minY: top, maxX: left + width, maxY: bottom };
}
