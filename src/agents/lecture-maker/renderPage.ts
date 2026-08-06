import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { paletteCss } from "./palette.js";

/**
 * The page a diagram is measured and photographed in.
 *
 * It has to be the *same* drawing the student sees, or measuring it proves
 * nothing. Three things have to match frontend/src/index.css and
 * components/blocks/blocks/SvgBlock.jsx: the diagram custom properties (without
 * them every `fill="var(--dia-1)"` resolves to nothing and the canvas renders
 * blank), Inter at the same weights, and the same inline-SVG-inside-a-figure
 * structure.
 *
 * The fonts are inlined as data URIs rather than served, so the page is fully
 * self-contained — `setContent` has no base URL to resolve a relative href
 * against, and standing up a static server just to measure a diagram would be a
 * second thing that can fail in the request path.
 */

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets", "fonts");

/** The weights the diagram prompt allows; keep in step with index.css. */
const FONT_WEIGHTS = [400, 500, 600] as const;

let fontCss: string | null = null;
let fontWarningLogged = false;

/**
 * `@font-face` blocks with the woff2 payload inlined. Read once and cached —
 * ~72KB of file turning into ~96KB of base64, on every diagram, would be a
 * silly amount of work to repeat.
 *
 * A missing font file must not stop a lecture: it degrades to the platform
 * fallback, which is what the app did before the font was self-hosted at all.
 * The measurement is then wrong in the old way rather than absent, and the
 * drift canary in scripts/svg-audit.ts is what surfaces it.
 */
function interFontCss(): string {
  if (fontCss !== null) return fontCss;
  const faces: string[] = [];
  for (const weight of FONT_WEIGHTS) {
    const file = path.join(FONT_DIR, `inter-latin-${weight}-normal.woff2`);
    try {
      const b64 = readFileSync(file).toString("base64");
      faces.push(
        `@font-face{font-family:'Inter';font-style:normal;font-weight:${weight};` +
          `src:url(data:font/woff2;base64,${b64}) format('woff2');}`,
      );
    } catch {
      if (!fontWarningLogged) {
        console.warn(
          `[lecture-maker] Inter not found at ${FONT_DIR} — diagrams will be measured in the fallback font. ` +
            `Ensure backend/assets/ is deployed alongside dist/.`,
        );
        fontWarningLogged = true;
      }
    }
  }
  fontCss = faces.join("");
  return fontCss;
}

/** True when at least one Inter face was inlined, so tests can assert on it. */
export function hasInterFonts(): boolean {
  return interFontCss().length > 0;
}

/**
 * Standard lecture canvas width. Every generated drawing uses `viewBox="0 0 700 H"`
 * (prompt.ts:118), so rendering at 700 CSS px makes one user unit one pixel and
 * keeps screenshots comparable between diagrams.
 */
export const CANVAS_WIDTH = 700;

export function buildHarnessHtml(svg: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
${interFontCss()}
:root{
${paletteCss()}
  font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--dia-surface);font-family:inherit}
#figure{width:${CANVAS_WIDTH}px;background:var(--dia-surface)}
#figure svg{display:block;width:100%;height:auto}
</style></head>
<body><figure id="figure">${svg}</figure></body></html>`;
}

/**
 * Forces every Inter weight to load, then waits for it.
 *
 * `document.fonts.ready` alone is not enough: a webfont is only fetched when
 * something actually uses it, so on a page whose SVG happens to reference only
 * one weight — or none, as when generating the metrics table — `ready` resolves
 * immediately and `check()` answers false for a font that would have loaded
 * fine. Measuring at that moment yields the fallback font's glyph widths while
 * reporting success, which is the worst of both outcomes.
 */
export const ENSURE_FONTS_SCRIPT = `(async () => {
  await Promise.all(${JSON.stringify(FONT_WEIGHTS)}.map((w) => document.fonts.load(w + ' 16px Inter')));
  await document.fonts.ready;
  return document.fonts.check('400 16px Inter');
})()`;

/**
 * Runs in the page. Returns every drawable element with its box in *viewBox*
 * units, transforms resolved.
 *
 * `getBBox()` gives an element's extent in its own local coordinate system, so
 * a shape inside `<g transform="translate(120,40)">` reports as if the group
 * were not there. Composing it with the matrix between that element and the svg
 * root is what makes grouped content measurable at all — the previous
 * regex-based reader simply ignored `transform` and judged such elements at
 * coordinates they were never drawn at.
 *
 * Serialised as a string because it is evaluated inside the browser context.
 * It must be an immediately-invoked expression, not a bare arrow function:
 * `page.evaluate` treats a string as an *expression*, so `() => {…}` would
 * evaluate to an unserialisable function object and silently yield undefined.
 */
export const MEASURE_SCRIPT = `(() => {
  const svg = document.querySelector('#figure svg');
  if (!svg) return null;
  const vb = svg.viewBox.baseVal;
  const rootCTM = svg.getScreenCTM();
  if (!rootCTM) return null;
  const toViewBox = rootCTM.inverse();

  const out = [];
  let index = 0;
  const SKIP = new Set(['svg','defs','marker','clippath','lineargradient','radialgradient',
    'stop','pattern','mask','animate','animatetransform','animatemotion','set','mpath','title','desc','g']);

  for (const el of svg.querySelectorAll('*')) {
    const tagName = el.tagName.toLowerCase();
    if (SKIP.has(tagName)) continue;
    let bbox;
    try { bbox = el.getBBox(); } catch (e) { continue; }
    // Zero-area elements draw nothing and only add noise to collision checks.
    if (!(bbox.width > 0) && !(bbox.height > 0)) continue;

    const ctm = el.getScreenCTM();
    if (!ctm) continue;
    const m = toViewBox.multiply(ctm);
    // Map all four corners: rotation and skew mean the axis-aligned box of the
    // transformed shape is not the transform of the axis-aligned local box.
    const pt = svg.createSVGPoint();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [dx, dy] of [[0,0],[1,0],[0,1],[1,1]]) {
      pt.x = bbox.x + bbox.width * dx;
      pt.y = bbox.y + bbox.height * dy;
      const p = pt.matrixTransform(m);
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }

    const entry = { tagName, box: { minX, minY, maxX, maxY }, index: index++ };
    const id = el.getAttribute('id');
    if (id) entry.id = id;
    if (tagName === 'text') {
      entry.text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
      const cs = getComputedStyle(el);
      entry.fontSize = parseFloat(cs.fontSize) || undefined;
      const anchor = el.getAttribute('text-anchor');
      if (anchor) entry.anchor = anchor;
    }
    out.push(entry);
  }

  return {
    viewBox: { width: vb.width, height: vb.height },
    elements: out,
    fontsReady: document.fonts.check('12px Inter'),
  };
})()`;
