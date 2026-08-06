import { rects as measuredRects, type SvgMeasurement } from "./measure.js";
import { measureByMetrics } from "./measureByMetrics.js";
import { elementIds, fontSizeOf, num, parseViewBox, str, textNodes, type Box } from "./svgParse.js";
import { labelLeft, measureText } from "./textMetrics.js";

/**
 * Repairs the mechanical damage a cheap model does to SVG, in code.
 *
 * A ~$0.10/1M model cannot do coordinate arithmetic — LayTextLLM finds the
 * coordinate-as-tokens approach "necessitates a considerably larger-sized LLM",
 * and telling such a model *in prose* that a label is off-canvas does not get it
 * fixed. So the repair round is no longer the first line of defence: these four
 * defects, all measured on real generated lectures, are corrected here before
 * the drawing is ever judged.
 *
 * Every rule is conservative — exact string matches and bounded nudges — so a
 * correct drawing passes through byte-identical.
 */

/** Keep-out margin from the canvas edge, matching the prompt's grid. */
const SAFE_MARGIN = 24;
/** A baseline closer than this to a box edge renders as sliced glyphs. */
const BORDER_CLEARANCE = 6;
/** How near the horizontal centre of a box counts as "meant to be centred". */
const CENTRE_TOLERANCE = 12;
/**
 * Taller than this and a rect is a container holding a column of lines, not a
 * label box — a lone line must not be re-centred inside it.
 */
const LABEL_BOX_MAX_HEIGHT = 160;
/** Clearance kept when nudging a line away from a container edge. */
const EDGE_PADDING = 14;

export interface FixOptions {
  /** The emission's alt text, so a copy drawn into the canvas can be removed. */
  alt?: string;
  /**
   * Measured geometry for the *incoming* markup. Supplied by callers that have
   * rendered it; otherwise the font-metrics measurer runs. Either way it is
   * re-derived internally after the leak strip, since that changes the markup.
   */
  measurement?: SvgMeasurement;
}

export interface FixResult {
  svg: string;
  /** One line per repair applied, for logging; empty when nothing changed. */
  repairs: string[];
}

/** Sets or replaces one attribute on an opening tag. */
function withAttr(tag: string, attr: string, value: string | number): string {
  const existing = new RegExp(`\\s${attr}\\s*=\\s*["'][^"']*["']`, "i");
  if (existing.test(tag)) return tag.replace(existing, ` ${attr}="${value}"`);
  const selfClosing = /\/>$/.test(tag);
  const head = tag.slice(0, selfClosing ? -2 : -1).trimEnd();
  return `${head} ${attr}="${value}"${selfClosing ? "/>" : ">"}`;
}

/** The smallest rect that horizontally contains this anchor point. */
function containingRect(rects: Box[], x: number, y: number): Box | null {
  let best: Box | null = null;
  for (const r of rects) {
    if (x <= r.minX || x >= r.maxX) continue;
    // Vertically the baseline may sit slightly outside — that is the defect.
    if (y < r.minY - BORDER_CLEARANCE || y > r.maxY + BORDER_CLEARANCE) continue;
    const area = (r.maxX - r.minX) * (r.maxY - r.minY);
    if (!best || area < (best.maxX - best.minX) * (best.maxY - best.minY)) best = r;
  }
  return best;
}

export function fixSvg(svg: string, opts: FixOptions = {}): FixResult {
  const repairs: string[] = [];
  const viewBox = parseViewBox(svg);
  if (!viewBox) return { svg, repairs };
  const { width, height } = viewBox;

  let out = svg;
  const ids = new Set(elementIds(svg));
  const altText = opts.alt?.trim();

  // --- 1. Strip text that leaked out of another field ------------------------
  // Exact matches only: an id printed as a caption ("s4-browser-bar"), or the
  // alt text drawn into the picture. Both are separate emission fields.
  //
  // Deliberately NOT "anything starting with alt:" — an HTML lesson legitimately
  // labels things "alt: accessibility", and an earlier version deleted it.
  for (const t of textNodes(out)) {
    const bare = t.content.replace(/^alt\s*:\s*/i, "");
    const leaked = ids.has(t.content) || (altText ? bare === altText || t.content === altText : false);
    if (!leaked) continue;
    out = out.replace(t.full, "");
    repairs.push(`removed leaked text "${t.content.slice(0, 40)}"`);
  }

  // Rect boxes are read once from the post-strip markup; the repairs below only
  // ever move <text>, so the shapes they are measured against never shift.
  // Measured rather than read off the tags, so a box inside a translated group
  // is compared against where it is actually drawn.
  const rects = measuredRects(measureByMetrics(out)).map((r) => r.box);

  for (const t of textNodes(out)) {
    if (!t.content) continue;
    let tag = t.tag;
    const size = fontSizeOf(tag);
    const x = num(tag, "x") ?? 0;
    const y = num(tag, "y") ?? 0;
    const w = measureText(t.content, size);
    const rect = containingRect(rects, x, y);

    // --- 2. Supply a missing text-anchor ------------------------------------
    let anchor = str(tag, "text-anchor");
    if (!anchor) {
      const centred = rect && Math.abs(x - (rect.minX + rect.maxX) / 2) < CENTRE_TOLERANCE;
      anchor = centred ? "middle" : "start";
      tag = withAttr(tag, "text-anchor", anchor);
      repairs.push(`added text-anchor="${anchor}" to "${t.content.slice(0, 30)}"`);
    }

    // --- 3. Lift a baseline off its box border ------------------------------
    // "Opening Tag" sat at y=170 on a box whose bottom edge was exactly 170.
    const onBottom = rect != null && Math.abs(y - rect.maxY) < BORDER_CLEARANCE;
    const onTop = rect != null && Math.abs(y - rect.minY) < BORDER_CLEARANCE;
    if (rect && (onBottom || onTop)) {
      const boxHeight = rect.maxY - rect.minY;
      if (boxHeight <= LABEL_BOX_MAX_HEIGHT) {
        // A label box: the text was meant to sit in the middle of it.
        const centreY = Math.round((rect.minY + rect.maxY) / 2);
        tag = withAttr(tag, "y", centreY);
        tag = withAttr(tag, "dominant-baseline", "middle");
        repairs.push(`centred "${t.content.slice(0, 30)}" in its box (y ${y} → ${centreY})`);
      } else {
        // A large container holding a column of lines — centring would be
        // nonsense; just clear the edge and keep its place in the column.
        const nudged = onBottom ? Math.round(rect.maxY - EDGE_PADDING) : Math.round(rect.minY + EDGE_PADDING);
        tag = withAttr(tag, "y", nudged);
        repairs.push(`nudged "${t.content.slice(0, 30)}" clear of its container edge (y ${y} → ${nudged})`);
      }
    }

    // --- 4. Pull a label back inside the canvas -----------------------------
    // Left-rail labels used anchor="end" at x=30, starting at x=-31.
    const currentY = num(tag, "y") ?? y;
    const left = labelLeft(x, w, anchor);
    if (left < SAFE_MARGIN - BORDER_CLEARANCE || left + w > width - SAFE_MARGIN + BORDER_CLEARANCE) {
      // Anchor from whichever edge leaves the label room, then clamp.
      if (w >= width - SAFE_MARGIN * 2) {
        // Too wide to fit anywhere: centre it and let the length check flag it.
        tag = withAttr(tag, "text-anchor", "middle");
        tag = withAttr(tag, "x", Math.round(width / 2));
      } else if (left < SAFE_MARGIN) {
        tag = withAttr(tag, "text-anchor", "start");
        tag = withAttr(tag, "x", SAFE_MARGIN);
      } else {
        tag = withAttr(tag, "text-anchor", "end");
        tag = withAttr(tag, "x", Math.round(width - SAFE_MARGIN));
      }
      repairs.push(`moved "${t.content.slice(0, 30)}" back inside the canvas`);
    }
    if (currentY > height - BORDER_CLEARANCE) {
      tag = withAttr(tag, "y", Math.round(height - SAFE_MARGIN / 2));
      repairs.push(`raised "${t.content.slice(0, 30)}" above the bottom edge`);
    }

    if (tag !== t.tag) out = out.replace(t.tag, tag);
  }

  out = stackCoincidentLabels(out, repairs);

  return { svg: out, repairs };
}

/** Vertical gap between stacked labels, as a multiple of the larger font size. */
const STACK_SPACING = 1.25;
/** How close two anchors must be to count as "the same spot". */
const COINCIDENT_TOLERANCE = 2;

/**
 * Separates labels drawn at the same anchor point.
 *
 * This is the reported defect: one box with "Element selector" and "p { }" both
 * at the same x and y, painted over each other and shipped. Nothing caught it,
 * because nothing compared two elements to each other.
 *
 * Deliberately narrow. It only acts when the anchors coincide to within a
 * couple of units, which is a mistake with no legitimate reading — two labels
 * genuinely meant for the same point cannot both be shown. Overlaps that arise
 * from *width* rather than position are left to the repair round, since the
 * right answer there is usually a shorter label or a wider box, and code
 * guessing between those would do more harm than reporting it.
 */
function stackCoincidentLabels(svg: string, repairs: string[]): string {
  const groups = new Map<string, { full: string; tag: string; content: string; size: number }[]>();

  for (const t of textNodes(svg)) {
    if (!t.content) continue;
    const x = num(t.tag, "x");
    const y = num(t.tag, "y");
    if (x == null || y == null) continue;
    const key = `${Math.round(x / COINCIDENT_TOLERANCE)}:${Math.round(y / COINCIDENT_TOLERANCE)}`;
    const bucket = groups.get(key) ?? [];
    bucket.push({ full: t.full, tag: t.tag, content: t.content, size: fontSizeOf(t.tag) });
    groups.set(key, bucket);
  }

  let out = svg;
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    const baseY = num(bucket[0]!.tag, "y") ?? 0;
    const spacing = Math.max(...bucket.map((b) => b.size)) * STACK_SPACING;
    const top = baseY - (spacing * (bucket.length - 1)) / 2;

    bucket.forEach((label, i) => {
      const y = Math.round(top + spacing * i);
      // The whole element is replaced, not just the opening tag: two labels at
      // one point can have byte-identical tags, and replacing by tag alone
      // would rewrite the first one twice and leave the second untouched.
      const fixed = label.full.replace(label.tag, withAttr(label.tag, "y", y));
      out = out.replace(label.full, fixed);
    });

    repairs.push(
      `stacked ${bucket.length} labels that shared one anchor point: ${bucket
        .map((b) => `"${b.content.slice(0, 24)}"`)
        .join(", ")}`,
    );
  }

  return out;
}
