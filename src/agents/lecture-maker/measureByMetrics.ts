import type { MeasuredElement, SvgMeasurement } from "./measure.js";
import { boxOf, fontSizeOf, num, parseViewBox, str } from "./svgParse.js";
import { DEFAULT_FONT_WEIGHT, textInkBox } from "./textMetrics.js";
import { applyBox, walkElements } from "./transform.js";

/**
 * Measures a drawing without a browser, for when Chromium is not there.
 *
 * It is the standby, never the preference: `measureInBrowser` is exact, and
 * this sums per-glyph advances (so kerning is missing) and cannot compute the
 * extent of a `<path>` without a path parser. It exists so that three things
 * hold — the rule tests run in milliseconds with no browser, a server that
 * cannot launch Chromium still generates lectures instead of failing them, and
 * the audit script has something to diff the browser against, which is what
 * turns "Inter quietly stopped loading" into a visible number.
 */

/** Structural elements that carry no ink of their own. */
const NON_DRAWING = /^(defs|marker|clippath|lineargradient|radialgradient|stop|pattern|mask|animate|animatetransform|animatemotion|set|mpath|title|desc)$/;

function fontWeightOf(tag: string): number {
  const attr = num(tag, "font-weight");
  if (attr != null) return attr;
  const styled = str(tag, "style")?.match(/font-weight\s*:\s*(\d+)/);
  if (styled) return Number(styled[1]);
  // `bold` is the only keyword these drawings use; anything else is the default.
  return /font-weight\s*[:=]\s*["']?bold/i.test(tag) ? 600 : DEFAULT_FONT_WEIGHT;
}

export function measureByMetrics(svg: string): SvgMeasurement {
  const viewBox = parseViewBox(svg) ?? { width: 0, height: 0 };
  const elements: MeasuredElement[] = [];
  let index = 0;

  for (const el of walkElements(svg)) {
    if (NON_DRAWING.test(el.tagName)) continue;

    let localBox = null;
    if (el.tagName === "text") {
      if (!el.content) continue;
      const fontSize = fontSizeOf(el.tag);
      localBox = textInkBox({
        x: num(el.tag, "x") ?? 0,
        y: num(el.tag, "y") ?? 0,
        content: el.content,
        fontSize,
        anchor: str(el.tag, "text-anchor"),
        dominantBaseline: str(el.tag, "dominant-baseline"),
        weight: fontWeightOf(el.tag),
      });
    } else {
      // Returns null for <path>, whose extent needs a path parser. Skipping it
      // means the fallback under-reports collisions involving arrows; the
      // browser path, which is the one that normally runs, has no such gap.
      localBox = boxOf(el.tagName, el.tag);
    }
    if (!localBox) continue;

    const entry: MeasuredElement = {
      tagName: el.tagName,
      box: applyBox(el.matrix, localBox),
      index: index++,
    };
    const id = str(el.tag, "id");
    if (id) entry.id = id;
    if (el.tagName === "text") {
      entry.text = el.content;
      entry.fontSize = fontSizeOf(el.tag);
      const anchor = str(el.tag, "text-anchor");
      if (anchor) entry.anchor = anchor;
    }
    elements.push(entry);
  }

  return { viewBox, elements, source: "metrics" };
}
