import { validateSvgCollisions } from "./collide.js";
import { emptyBox, texts as measuredTexts, rects as measuredRects, widen, type SvgMeasurement } from "./measure.js";
import { measureByMetrics } from "./measureByMetrics.js";
import { ALLOWED_COLOR_VARS } from "./palette.js";
import { elementIds, num, textNodes, type Box } from "./svgParse.js";

/**
 * Deterministic legibility checks on worker-produced SVG.
 *
 * validate.ts answers "is this safe and well-formed"; this answers "is the
 * drawing actually readable". Every rule here maps to a defect measured on real
 * generated lectures: labels running off the canvas, text left-aligned where it
 * was meant to be centred, a drawing floating in a canvas 60% empty, text sliced
 * by the box it sits in, an id printed as a caption, and `id="arrowhead"`
 * colliding across two SVGs on the same page (ids are document-wide, so the
 * second block silently used the first block's marker).
 *
 * Issues are returned as plain sentences and fed straight into the existing
 * repair round, the same way validateSvgMarkup's are — no extra LLM call.
 * fixSvg.ts repairs most of these first, so what reaches here is what code
 * could not fix on its own.
 *
 * Geometry comes from a `SvgMeasurement` rather than from the markup. Callers
 * that have rendered the drawing pass the browser's measurement, which is exact;
 * everyone else — including every test in this repo — gets the font-metrics
 * measurer by default. It used to read coordinates off the tags itself, which
 * meant guessing text widths from a flat per-character ratio and ignoring
 * `transform` altogether.
 */

/** A label longer than this cannot be read comfortably and never wraps. */
const MAX_LABEL_CHARS = 40;
const MIN_FONT_SIZE = 11;
/** Below this share of the canvas the drawing looks lost in empty space. */
const MIN_FILL_RATIO = 0.55;
/** Slack in user units before a stray coordinate counts as off-canvas. */
const EDGE_TOLERANCE = 2;
/** How close a baseline may sit to a box edge before it looks sliced. */
export const BORDER_CLEARANCE = 6;

export interface GeometryOptions {
  /** Every id must start with this, so two SVGs on one page can't collide. */
  idPrefix?: string;
  /** The emission's alt text — it belongs in the alt field, not in the picture. */
  alt?: string;
  /**
   * Measured geometry. Supply the browser's when one is available; otherwise
   * the font-metrics measurer runs, which is close but not exact.
   */
  measurement?: SvgMeasurement;
}

export function validateSvgGeometry(svg: string, opts: GeometryOptions = {}): string[] {
  const issues: string[] = [];
  const m = opts.measurement ?? measureByMetrics(svg);
  const { width, height } = m.viewBox;
  // validateSvgMarkup already reports a missing viewBox; without one there is
  // no canvas to judge anything against.
  if (!(width > 0 && height > 0)) return issues;

  // 1. id prefix — the real cause of markers bleeding between blocks.
  const ids = elementIds(svg);
  if (opts.idPrefix) {
    const bad = ids.filter((id) => !id.startsWith(opts.idPrefix!));
    if (bad.length > 0) {
      issues.push(
        `every id must start with "${opts.idPrefix}" (including markers and gradients) — fix: ${[...new Set(bad)].slice(0, 6).join(", ")}`,
      );
    }
  }

  // 2. Canvas fit, plus the content bounds needed for the fill-ratio check.
  const content: Box = emptyBox();
  const outside: string[] = [];
  for (const el of m.elements) {
    widen(content, el.box);
    if (
      el.box.minX < -EDGE_TOLERANCE ||
      el.box.minY < -EDGE_TOLERANCE ||
      el.box.maxX > width + EDGE_TOLERANCE ||
      el.box.maxY > height + EDGE_TOLERANCE
    ) {
      outside.push(el.tagName);
    }
  }
  if (outside.length > 0) {
    issues.push(
      `${outside.length} element(s) fall outside the ${width}x${height} viewBox (${[...new Set(outside)].join(", ")}) — every shape must sit inside it`,
    );
  }

  // 3-7. Per-label checks. text-anchor and the leak checks read the markup,
  // because they are about what was written, not about where it landed.
  const tags = textNodes(svg);
  const missingAnchor = tags.filter((t) => !/text-anchor\s*=/.test(t.tag)).length;
  if (missingAnchor > 0) {
    issues.push(
      `${missingAnchor} of ${tags.length} <text> elements have no text-anchor — set it explicitly (middle for anything centred on a shape, otherwise start)`,
    );
  }

  const labels = measuredTexts(m);
  const small = labels.filter((t) => (t.fontSize ?? MIN_FONT_SIZE) < MIN_FONT_SIZE).length;
  if (small > 0) issues.push(`${small} <text> elements are below font-size ${MIN_FONT_SIZE} — too small to read`);

  // Counted on decoded text: `&lt;h1&gt;` is four characters on screen, not
  // twelve, and warning about the length of a four-character label was noise.
  const tooLong = labels.filter((t) => (t.text?.length ?? 0) > MAX_LABEL_CHARS);
  if (tooLong.length > 0) {
    issues.push(
      `${tooLong.length} label(s) exceed ${MAX_LABEL_CHARS} characters and SVG text never wraps — split them into stacked <text> lines: "${tooLong[0]!.text!.slice(0, 50)}…"`,
    );
  }

  // The alt text and internal ids are separate fields; drawing them into the
  // picture is a real defect seen in generated lectures ("s4-browser-bar").
  // Matched exactly (optionally behind an "Alt:" prefix) — a bare `^alt:` rule
  // would flag legitimate labels like "alt: accessibility" in an HTML lesson.
  const idSet = new Set(ids);
  const altText = opts.alt?.trim();
  const leaked = tags.filter((t) => {
    if (idSet.has(t.content)) return true;
    if (!altText) return false;
    return t.content === altText || t.content.replace(/^alt\s*:\s*/i, "") === altText;
  });
  if (leaked.length > 0) {
    issues.push(
      `${leaked.length} <text> element(s) print an id or the alt text into the drawing — remove them, both are separate fields: "${leaked[0]!.content.slice(0, 40)}"`,
    );
  }

  const overflowing = labels.filter(
    (t) =>
      t.box.minX < -EDGE_TOLERANCE ||
      t.box.maxX > width + EDGE_TOLERANCE ||
      t.box.minY > height + EDGE_TOLERANCE,
  );
  if (overflowing.length > 0) {
    issues.push(
      `${overflowing.length} label(s) run past the canvas edge — shorten them or move them inward: "${overflowing[0]!.text!.slice(0, 30)}…"`,
    );
  }

  // A baseline sitting on the edge of the box that contains it renders as
  // half-cut glyphs — the "Opening Tag" defect. Read from the markup because it
  // is the declared baseline that is wrong, not the resulting ink box.
  const boxes = measuredRects(m);
  const sliced: string[] = [];
  for (const t of tags) {
    if (!t.content) continue;
    const x = num(t.tag, "x") ?? 0;
    const y = num(t.tag, "y") ?? 0;
    const onBorder = boxes.some(
      (r) =>
        x > r.box.minX &&
        x < r.box.maxX &&
        (Math.abs(y - r.box.maxY) < BORDER_CLEARANCE || Math.abs(y - r.box.minY) < BORDER_CLEARANCE),
    );
    if (onBorder) sliced.push(t.content.slice(0, 30));
  }
  if (sliced.length > 0) {
    issues.push(
      `${sliced.length} label(s) sit on the border of their box and render sliced — centre them vertically (y = boxY + boxHeight/2 with dominant-baseline="middle"): "${sliced[0]}…"`,
    );
  }

  // 8. Fill ratio — a drawing marooned in empty space.
  if (Number.isFinite(content.minX) && Number.isFinite(content.maxY)) {
    const used = Math.max(0, content.maxY - Math.max(0, content.minY));
    const ratio = used / height;
    if (ratio < MIN_FILL_RATIO) {
      issues.push(
        `the drawing only fills ${Math.round(ratio * 100)}% of the ${width}x${height} canvas — shrink the viewBox height to about ${Math.max(200, Math.ceil((content.maxY + 24) / 20) * 20)} so it doesn't float in empty space`,
      );
    }
  }

  // 9. Collisions. Last because they are the most expensive to describe and the
  // most useful to act on, so they should not be truncated away by earlier noise.
  issues.push(...validateSvgCollisions(m));

  return issues;
}

const COLOR_ATTRS = /\b(fill|stroke|stop-color|color)\s*=\s*["']([^"']+)["']/gi;

/**
 * On a SMIL animation element `fill` is not a colour at all — it selects the
 * end-state behaviour. Treating "freeze" as a bad colour penalised perfectly
 * valid animation.
 */
const SMIL_FILL_VALUES = /^(freeze|remove)$/i;

/**
 * Keeps drawings on the validated palette. Raw hex is the common failure and
 * it is what makes one lecture's colours clash with the next. The allowed names
 * come from palette.ts, which is also what defines them on the measurement
 * page — so a colour that validates here is one that will actually render.
 */
export function validateSvgPalette(svg: string): string[] {
  const bad = new Set<string>();
  for (const m of svg.matchAll(COLOR_ATTRS)) {
    const value = m[2]!.trim();
    if (/^(none|transparent|inherit|currentcolor)$/i.test(value)) continue;
    if (m[1]!.toLowerCase() === "fill" && SMIL_FILL_VALUES.test(value)) continue;
    if (value.startsWith("url(")) continue;
    const varName = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
    if (varName && ALLOWED_COLOR_VARS.has(varName[1]!)) continue;
    bad.add(value.slice(0, 24));
  }
  if (bad.size === 0) return [];
  return [
    `only the diagram palette may be used (var(--dia-1..5), var(--dia-N-tint), var(--dia-ink), var(--dia-ink-soft), var(--dia-surface), var(--dia-line)) — replace: ${[...bad].slice(0, 6).join(", ")}`,
  ];
}
