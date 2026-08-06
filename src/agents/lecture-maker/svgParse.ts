/**
 * Small regex primitives for reading worker-produced SVG without a DOM.
 *
 * Shared by geometry.ts (which judges a drawing) and fixSvg.ts (which repairs
 * one), so both agree on how a tag's attributes, a label's width and an
 * element's drawn extent are computed.
 */

export const DEFAULT_FONT_SIZE = 12;

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function parseViewBox(svg: string): { width: number; height: number } | null {
  const m = svg.match(/viewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)/i);
  if (!m) return null;
  const width = Number(m[3]);
  const height = Number(m[4]);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

export function num(tag: string, attr: string): number | null {
  const m = tag.match(new RegExp(`\\s${attr}\\s*=\\s*["']([-\\d.]+)`, "i"));
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

export function str(tag: string, attr: string): string | null {
  const m = tag.match(new RegExp(`\\s${attr}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? m[1]! : null;
}

/** Font size on the element, else the document default. */
export function fontSizeOf(tag: string): number {
  const attr = num(tag, "font-size");
  if (attr != null) return attr;
  const styled = str(tag, "style")?.match(/font-size\s*:\s*([\d.]+)/);
  return styled ? Number(styled[1]) : DEFAULT_FONT_SIZE;
}

/** Drawn extent of one element, as far as its own attributes reveal it. */
export function boxOf(tagName: string, tag: string): Box | null {
  const name = tagName.toLowerCase();

  if (name === "rect" || name === "image" || name === "foreignobject") {
    const x = num(tag, "x") ?? 0;
    const y = num(tag, "y") ?? 0;
    const w = num(tag, "width");
    const h = num(tag, "height");
    if (w == null || h == null) return null;
    return { minX: x, minY: y, maxX: x + w, maxY: y + h };
  }

  if (name === "circle" || name === "ellipse") {
    const cx = num(tag, "cx") ?? 0;
    const cy = num(tag, "cy") ?? 0;
    const rx = num(tag, "r") ?? num(tag, "rx");
    const ry = num(tag, "r") ?? num(tag, "ry");
    if (rx == null || ry == null) return null;
    return { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry };
  }

  if (name === "line") {
    const x1 = num(tag, "x1");
    const y1 = num(tag, "y1");
    const x2 = num(tag, "x2");
    const y2 = num(tag, "y2");
    if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
    return { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) };
  }

  if (name === "polygon" || name === "polyline") {
    const points = str(tag, "points");
    if (!points) return null;
    const nums = points.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
    if (nums.length < 4) return null;
    const xs = nums.filter((_, i) => i % 2 === 0);
    const ys = nums.filter((_, i) => i % 2 === 1);
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }

  return null;
}

/** Every element tag in the markup, paired with its name. */
export function elements(svg: string): { tagName: string; tag: string }[] {
  const out: { tagName: string; tag: string }[] = [];
  for (const m of svg.matchAll(/<([A-Za-z][\w:-]*)\b[^>]*?\/?>/g)) {
    out.push({ tagName: m[1]!, tag: m[0]! });
  }
  return out;
}

/**
 * Every `id` attribute actually declared on an element.
 *
 * Deliberately not a plain `/\bid\s*=\s*"…"/` sweep of the markup: a label
 * reading `<section id="hero">` is stored escaped, so a raw scan finds `hero`
 * inside the *text* and reports it as an id that broke the prefix rule. In an
 * app that teaches HTML those labels are everywhere, and the false alarm cost a
 * repair round on a perfectly good drawing.
 */
export function elementIds(svg: string): string[] {
  const out: string[] = [];
  for (const { tag } of elements(svg)) {
    const id = str(tag, "id");
    if (id) out.push(id);
  }
  return out;
}

/** Structural elements that carry no ink and shouldn't affect bounds. */
export const NON_DRAWING_TAGS =
  /^(svg|defs|marker|clippath|lineargradient|radialgradient|stop|pattern|mask|animate|animatetransform|animatemotion|set|mpath|title|desc|g)$/i;

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Turns markup text into the characters the browser will actually draw.
 *
 * Without this a label reading `&lt;h1&gt;` was measured as twelve characters
 * rather than the four that get painted — a 93% over-measurement, on the single
 * commonest kind of label in an app that teaches HTML and CSS. It made long-label
 * warnings fire on short labels and overflow arithmetic meaningless for any
 * code snippet.
 *
 * `&amp;` is resolved last so `&amp;lt;` decodes to the literal text `&lt;`
 * rather than being decoded twice into `<`.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&(lt|gt|quot|apos|nbsp);/g, (_, name: string) => NAMED_ENTITIES[name]!)
    .replace(/&amp;/g, "&");
}

export interface TextNode {
  /** The opening tag alone, e.g. `<text x="10" y="20">`. */
  tag: string;
  /** Visible label with tspans and indentation stripped. */
  content: string;
  /** The whole `<text>…</text>` element, for replacement. */
  full: string;
}

/** `<text>` elements with their content, so labels can be measured. */
export function textNodes(svg: string): TextNode[] {
  return [...svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text\s*>/gi)].map((m) => ({
    tag: `<text${m[1]}>`,
    content: decodeEntities(m[2]!.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim(),
    full: m[0]!,
  }));
}

// labelWidth/labelLeft/rectBoxes used to live here. Width is now measured
// (textMetrics.ts, or the browser) instead of guessed from a flat per-character
// ratio, and boxes come from a SvgMeasurement so that transforms are applied.
