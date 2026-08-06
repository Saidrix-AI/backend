import { decodeEntities, type Box } from "./svgParse.js";

/**
 * `transform` resolution for the fallback measurer.
 *
 * The browser path gets this free from `getScreenCTM()`. This exists so that
 * when Chromium is unavailable the fallback is not *silently* wrong about
 * grouped content — which is exactly what the old regex reader was: it read
 * coordinates straight off each tag and skipped `<g>` entirely, so every shape
 * inside a `<g transform="translate(120,40)">` was judged at a position it was
 * never drawn at, and no rule could tell.
 */

/** SVG matrix [a b c d e f]: x' = ax + cy + e, y' = bx + dy + f. */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function applyPoint(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/**
 * Axis-aligned box of a transformed box. All four corners are mapped, not just
 * the two extremes: under rotation or skew the transform of the corner points
 * is not the same as the corners of the transformed box.
 */
export function applyBox(m: Matrix, box: Box): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.minX, box.maxY],
    [box.maxX, box.maxY],
  ] as const) {
    const p = applyPoint(m, x, y);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

const FN = /([a-zA-Z]+)\s*\(([^)]*)\)/g;

function args(raw: string): number[] {
  return raw
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter(Number.isFinite);
}

/** Parses a `transform` attribute value. Functions apply left to right. */
export function parseTransform(value: string | null | undefined): Matrix {
  if (!value) return IDENTITY;
  let m: Matrix = IDENTITY;
  FN.lastIndex = 0;
  for (const match of value.matchAll(FN)) {
    const name = match[1]!.toLowerCase();
    const a = args(match[2]!);
    let next: Matrix | null = null;
    switch (name) {
      case "translate":
        next = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case "scale": {
        const sx = a[0] ?? 1;
        next = [sx, 0, 0, a[1] ?? sx, 0, 0];
        break;
      }
      case "rotate": {
        const rad = ((a[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const rot: Matrix = [cos, sin, -sin, cos, 0, 0];
        // The 3-argument form rotates about a point, not the origin.
        if (a.length >= 3) {
          const cx = a[1]!;
          const cy = a[2]!;
          next = multiply(multiply([1, 0, 0, 1, cx, cy], rot), [1, 0, 0, 1, -cx, -cy]);
        } else {
          next = rot;
        }
        break;
      }
      case "skewx":
        next = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewy":
        next = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
      case "matrix":
        if (a.length >= 6) next = [a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!];
        break;
      default:
        next = null;
    }
    if (next) m = multiply(m, next);
  }
  return m;
}

export interface WalkedElement {
  /** Lowercased tag name. */
  tagName: string;
  /** The opening tag verbatim, for attribute reads. */
  tag: string;
  /** Accumulated transform from the svg root down to this element. */
  matrix: Matrix;
  /** `<text>` only: visible content with tspans and indentation stripped. */
  content?: string;
  /** `<text>` only: the whole element, so fixSvg can replace it. */
  full?: string;
}

const TAG = /<(\/?)([A-Za-z][\w:-]*)\b([^>]*?)(\/?)>/g;

/**
 * Walks the markup in document order, carrying a matrix stack.
 *
 * A real DOM would be tidier, but the rest of this agent reads SVG with regexes
 * and adding a parser dependency for the *fallback* path — the one that only
 * runs when the browser is already unavailable — is not a trade worth making.
 */
export function walkElements(svg: string): WalkedElement[] {
  const out: WalkedElement[] = [];
  const stack: Matrix[] = [IDENTITY];
  TAG.lastIndex = 0;

  for (const m of svg.matchAll(TAG)) {
    const closing = m[1] === "/";
    const tagName = m[2]!.toLowerCase();
    const attrs = m[3] ?? "";
    const selfClosing = m[4] === "/";
    const current = stack[stack.length - 1]!;

    if (closing) {
      // Only containers pushed a frame, so only they pop one. The guard keeps
      // malformed markup (a stray </g>) from unwinding past the root.
      if ((tagName === "g" || tagName === "svg") && stack.length > 1) stack.pop();
      continue;
    }

    const own = parseTransform(attrs.match(/\stransform\s*=\s*["']([^"']*)["']/i)?.[1]);
    const combined = own === IDENTITY ? current : multiply(current, own);

    if (tagName === "g" || tagName === "svg") {
      if (!selfClosing) stack.push(combined);
      continue;
    }

    const entry: WalkedElement = { tagName, tag: m[0]!, matrix: combined };

    if (tagName === "text") {
      // Content runs to the matching close tag; nested markup (tspan) is
      // stripped the same way textNodes() does it, so both agree.
      const start = (m.index ?? 0) + m[0]!.length;
      const end = svg.indexOf("</text", start);
      if (end > -1) {
        entry.content = decodeEntities(svg.slice(start, end).replace(/<[^>]*>/g, ""))
          .replace(/\s+/g, " ")
          .trim();
        entry.full = svg.slice(m.index ?? 0, svg.indexOf(">", end) + 1);
      }
    }

    out.push(entry);
  }

  return out;
}
