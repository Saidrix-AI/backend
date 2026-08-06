import {
  area,
  contains,
  hostRect,
  intersectionArea,
  intersects,
  overlapTolerance,
  rects,
  texts,
  type MeasuredElement,
  type SvgMeasurement,
} from "./measure.js";

/**
 * The check the drawing pipeline never had: does anything sit on top of
 * anything else.
 *
 * validateSvgGeometry has nine rules — id prefixes, canvas fit, text-anchor,
 * font size, label length, leaked ids, off-canvas labels, baselines on borders,
 * fill ratio — and a drawing that prints two labels in the same place passes
 * every one of them. That is precisely the defect that was reported: "Element
 * selector" and "p { }" rendered on top of each other inside one box, shipped
 * to students, and no check could see it, because nothing ever compared two
 * elements to each other.
 *
 * These rules need genuinely measured boxes, which is why they live behind
 * SvgMeasurement rather than reading markup: under the old flat-ratio width
 * estimate a label could be judged 45% narrower than it draws, so collisions
 * would be missed and non-collisions invented.
 */

/**
 * Rect overlap below this share of the smaller rect is ignored. Adjacent boxes
 * whose borders touch, and stroke widths straddling a shared edge, are normal
 * drawing, not a defect.
 */
const MIN_RECT_OVERLAP_RATIO = 0.04;

/** Padding a label is expected to keep from the inside of its box. */
const LABEL_PADDING = 4;

function quote(el: MeasuredElement): string {
  const label = el.text ?? el.id ?? el.tagName;
  return label.length > 34 ? `${label.slice(0, 34)}…` : label;
}

/**
 * Labels drawn over each other.
 *
 * Reported first and worded with both labels and the anchor to move, because
 * this is the one a model can actually act on: the fix is to stack them, and
 * the repair round needs to know which two.
 */
function textCollisions(m: SvgMeasurement, tolerance: number): string[] {
  const labels = texts(m);
  const issues: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i]!;
      const b = labels[j]!;
      if (!intersects(a.box, b.box, tolerance)) continue;
      const key = `${a.index}-${b.index}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const overlap = intersectionArea(a.box, b.box);
      const smaller = Math.min(area(a.box), area(b.box));
      const pct = smaller > 0 ? Math.round((overlap / smaller) * 100) : 100;
      issues.push(
        `"${quote(a)}" and "${quote(b)}" overlap by ${pct}% — two labels must never share the same spot; ` +
          `stack them (one above the other, about 1.2x the font-size apart) or move one into its own row`,
      );
    }
  }
  return issues;
}

/**
 * Labels wider than the box that is supposed to hold them.
 *
 * Distinct from the existing off-canvas rule: this fires well inside the canvas,
 * where a label overruns the shape it labels. With a guessed width it was
 * undetectable — that guess ran 45% light on wide labels, which are the only
 * ones that ever overflow.
 */
function labelOverflows(m: SvgMeasurement): string[] {
  const issues: string[] = [];
  for (const label of texts(m)) {
    const host = hostRect(m, label);
    if (!host) continue;
    const overshootLeft = host.box.minX + LABEL_PADDING - label.box.minX;
    const overshootRight = label.box.maxX - (host.box.maxX - LABEL_PADDING);
    const overshoot = Math.max(overshootLeft, overshootRight);
    if (overshoot <= 0) continue;

    const boxWidth = host.box.maxX - host.box.minX;
    const labelWidth = label.box.maxX - label.box.minX;
    issues.push(
      `"${quote(label)}" is ${Math.round(labelWidth)} units wide but its box is only ${Math.round(boxWidth)} — ` +
        `it overruns the edge by ${Math.ceil(overshoot)}; shorten the label, split it across two lines, or widen the box`,
    );
  }
  return issues;
}

/**
 * Boxes that partly cover each other.
 *
 * Full nesting is deliberate and extremely common here — "function scope inside
 * global scope" is the archetypal lecture diagram — so containment is excluded
 * and only *partial* overlap is a defect. Lines, paths and arrows are excluded
 * entirely: crossing a box is what an arrow is for.
 */
function rectCollisions(m: SvgMeasurement, tolerance: number): string[] {
  const boxes = rects(m);
  const issues: string[] = [];

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (!intersects(a.box, b.box, tolerance)) continue;
      if (contains(a.box, b.box, tolerance) || contains(b.box, a.box, tolerance)) continue;

      const overlap = intersectionArea(a.box, b.box);
      const smaller = Math.min(area(a.box), area(b.box));
      if (smaller <= 0 || overlap / smaller < MIN_RECT_OVERLAP_RATIO) continue;

      issues.push(
        `the boxes "${quote(a)}" and "${quote(b)}" overlap by ${Math.round((overlap / smaller) * 100)}% without ` +
          `one containing the other — separate them, or nest one fully inside the other if that is the intent`,
      );
    }
  }
  return issues;
}

/**
 * Every collision defect in one drawing, worded for the repair round.
 *
 * Capped, because a drawing that has gone badly wrong can generate dozens of
 * pairs and a repair message listing all of them is worse than one listing the
 * first few — the model stops acting on any of it.
 */
export function validateSvgCollisions(m: SvgMeasurement): string[] {
  const tolerance = overlapTolerance(m.source);
  return [...textCollisions(m, tolerance), ...labelOverflows(m), ...rectCollisions(m, tolerance)].slice(0, 8);
}
