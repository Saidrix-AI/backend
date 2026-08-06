import type { Box } from "./svgParse.js";

/**
 * The vocabulary every legibility rule speaks, and the seam between *measuring*
 * a drawing and *judging* one.
 *
 * Before this existed, geometry.ts and fixSvg.ts each re-derived boxes straight
 * from the markup with regexes. That made two things impossible. Text width was
 * a guess (`chars * fontSize * 0.55`, one flat ratio for every glyph — off by
 * ±25% on real labels, since `i` is 0.26em and `W` is 0.87em), and `transform`
 * was ignored entirely, so anything inside a `<g transform="translate(...)">`
 * was judged at coordinates it was never drawn at.
 *
 * Splitting the two lets the browser do the measuring — it is the only thing
 * that knows what a glyph is actually going to be — while the rules stay pure
 * functions over boxes, so they unit-test with hand-written coordinates and
 * never need Chromium.
 */

/** One drawable element, resolved to viewBox coordinates. */
export interface MeasuredElement {
  /** Lowercased tag name: rect, text, line, circle, path… */
  tagName: string;
  id?: string;
  /**
   * Drawn extent in viewBox units, transforms already applied. For `<text>`
   * this is the inked box of the glyphs, not the anchor point.
   */
  box: Box;
  /** `<text>` only: the visible label, tspans flattened. */
  text?: string;
  /** `<text>` only, resolved through inheritance where the measurer can. */
  fontSize?: number;
  /** `<text>` only: start | middle | end, absent when the markup omits it. */
  anchor?: string;
  /** Document order, so an issue can name "the 3rd label" reproducibly. */
  index: number;
}

/**
 * `source` matters to the rules: browser boxes are exact and may be trusted to
 * the pixel, metrics boxes carry a small residual error, so a rule that would
 * fire on a 1px overlap must not fire on a metrics measurement.
 */
export type MeasurementSource = "browser" | "metrics";

export interface SvgMeasurement {
  viewBox: { width: number; height: number };
  elements: MeasuredElement[];
  source: MeasurementSource;
}

/**
 * Slack a rule must allow before calling two boxes overlapping. The browser is
 * exact, so anything above hairline is real; the metrics fallback sums per-glyph
 * advance widths without kerning, which drifts by about a percent on a long
 * label, so it needs room or it invents collisions in correct drawings.
 */
export function overlapTolerance(source: MeasurementSource): number {
  return source === "browser" ? 0.5 : 3;
}

// --- Box arithmetic --------------------------------------------------------
// Shared so "overlaps", "contains" and "area" mean exactly one thing across
// geometry.ts, collide.ts and fixSvg.ts.

export function width(b: Box): number {
  return b.maxX - b.minX;
}

export function height(b: Box): number {
  return b.maxY - b.minY;
}

export function area(b: Box): number {
  return Math.max(0, width(b)) * Math.max(0, height(b));
}

/** Overlapping area of two boxes; 0 when they merely touch or miss. */
export function intersectionArea(a: Box, b: Box): number {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return w > 0 && h > 0 ? w * h : 0;
}

/** True when the boxes share area on both axes by more than `tolerance`. */
export function intersects(a: Box, b: Box, tolerance = 0): boolean {
  return (
    Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > tolerance &&
    Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) > tolerance
  );
}

/**
 * True when `inner` sits wholly inside `outer`. Nesting is deliberate in these
 * drawings — "function scope inside global scope" is the single commonest
 * lecture diagram — so containment must be distinguishable from collision.
 */
export function contains(outer: Box, inner: Box, tolerance = 0): boolean {
  return (
    inner.minX >= outer.minX - tolerance &&
    inner.minY >= outer.minY - tolerance &&
    inner.maxX <= outer.maxX + tolerance &&
    inner.maxY <= outer.maxY + tolerance
  );
}

/** Grows `into` to also cover `add`. */
export function widen(into: Box, add: Box): void {
  into.minX = Math.min(into.minX, add.minX);
  into.minY = Math.min(into.minY, add.minY);
  into.maxX = Math.max(into.maxX, add.maxX);
  into.maxY = Math.max(into.maxY, add.maxY);
}

export function emptyBox(): Box {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

// --- Selectors -------------------------------------------------------------

/** Labels, in document order. */
export function texts(m: SvgMeasurement): MeasuredElement[] {
  return m.elements.filter((e) => e.tagName === "text" && (e.text?.length ?? 0) > 0);
}

/** `<rect>` only — the containment tests are written against boxes, not blobs. */
export function rects(m: SvgMeasurement): MeasuredElement[] {
  return m.elements.filter((e) => e.tagName === "rect");
}

/** Everything that draws ink and is not a label. */
export function shapes(m: SvgMeasurement): MeasuredElement[] {
  return m.elements.filter((e) => e.tagName !== "text");
}

/**
 * The smallest rect that fully contains `box`, if any — the box a label was
 * meant to sit in. Smallest wins so a label inside a nested pair is attributed
 * to the inner box, which is the one whose padding it has to respect.
 */
export function containingRect(m: SvgMeasurement, box: Box, tolerance = 2): MeasuredElement | null {
  let best: MeasuredElement | null = null;
  for (const r of rects(m)) {
    if (!contains(r.box, box, tolerance)) continue;
    if (!best || area(r.box) < area(best.box)) best = r;
  }
  return best;
}

/**
 * The smallest rect this label is *horizontally* inside and vertically near.
 * Deliberately looser than `containingRect`: a label that overflows its box is
 * exactly the defect being looked for, so it must still be attributed to the
 * box it overflows rather than falling through as unattached.
 */
export function hostRect(m: SvgMeasurement, label: MeasuredElement, slack = 8): MeasuredElement | null {
  const cx = (label.box.minX + label.box.maxX) / 2;
  const cy = (label.box.minY + label.box.maxY) / 2;
  let best: MeasuredElement | null = null;
  for (const r of rects(m)) {
    if (cx < r.box.minX || cx > r.box.maxX) continue;
    if (cy < r.box.minY - slack || cy > r.box.maxY + slack) continue;
    if (!best || area(r.box) < area(best.box)) best = r;
  }
  return best;
}
