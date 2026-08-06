import "dotenv/config";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { buildHarnessHtml, ENSURE_FONTS_SCRIPT } from "../src/agents/lecture-maker/renderPage.js";

/**
 * Regenerates src/agents/lecture-maker/interMetrics.ts.
 *
 * The table is measured *in the browser*, not read out of the font file with a
 * parser. That is deliberate: its only job is to approximate what Chromium will
 * do when the fallback measurer has to stand in for it, so generating it from
 * Chromium makes it as close as the approach allows by construction — and drops
 * a font-parsing dependency that could disagree with the renderer about
 * hinting, synthesis or which face won.
 *
 * `ctx.measureText(ch).width` is the *advance* width — the distance the pen
 * moves — which is what summing a label needs. An ink bounding box would be
 * wrong here: it excludes side bearings, so a space would measure zero.
 *
 * Run: npx tsx scripts/gen-font-metrics.ts
 */

const WEIGHTS = [400, 500, 600] as const;

/** Printable ASCII, plus the punctuation diagrams reach for. */
const CHARS = [
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
  "—", "–", "→", "←", "↑", "↓", "·", "×", "÷", "≈", "≤", "≥", "≠", "…", "•", "°",
  "“", "”", "‘", "’", "✓", "✗",
];

const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "agents",
  "lecture-maker",
  "interMetrics.ts",
);

const browser = await chromium.launch({ args: ["--disable-gpu", "--no-sandbox"] });
const page = await browser.newPage();
// Reuse the real harness page so the @font-face rules and the family stack are
// byte-identical to the ones diagrams are measured against.
await page.setContent(buildHarnessHtml("<svg viewBox='0 0 10 10'></svg>"), { waitUntil: "load" });
await page.evaluate(ENSURE_FONTS_SCRIPT);

const measured = (await page.evaluate(`(() => {
  const chars = ${JSON.stringify(CHARS)};
  const weights = ${JSON.stringify(WEIGHTS)};
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const SIZE = 200; // large sample, so rounding is well below a thousandth of an em
  const out = {};
  for (const w of weights) {
    ctx.font = w + ' ' + SIZE + 'px Inter';
    const row = {};
    for (const ch of chars) row[ch] = ctx.measureText(ch).width / SIZE;
    out[w] = row;
  }
  return { out, ready: document.fonts.check('12px Inter') };
})()`)) as { out: Record<string, Record<string, number>>; ready: boolean };

/**
 * Vertical metrics, measured the same way rather than assumed.
 *
 * The fallback measurer has to turn a baseline `y` into an inked box, and that
 * depends on where the font sits relative to its baseline and on how
 * `dominant-baseline="middle"` shifts it — the attribute the diagram prompt
 * mandates for anything centred in a shape. Both are read off a real render at
 * a known font-size instead of being estimated from em-square folklore.
 */
const vertical = (await page.evaluate(`(() => {
  const SIZE = 100, Y = 400;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 800 800');
  svg.setAttribute('width', '800');
  document.body.appendChild(svg);
  const make = (baseline) => {
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', '20');
    t.setAttribute('y', String(Y));
    t.setAttribute('font-family', 'Inter');
    t.setAttribute('font-size', String(SIZE));
    if (baseline) t.setAttribute('dominant-baseline', baseline);
    // Mixed ascenders, descenders and caps, so the box is the font's full extent.
    t.textContent = 'Hxdgp';
    svg.appendChild(t);
    return t.getBBox();
  };
  const plain = make(null);
  const middle = make('middle');
  return {
    ascent: (Y - plain.y) / SIZE,
    descent: (plain.y + plain.height - Y) / SIZE,
    middleShift: (middle.y - plain.y) / SIZE,
  };
})()`)) as { ascent: number; descent: number; middleShift: number };

await browser.close();

if (!measured.ready) {
  console.error("Inter did not load in the harness page — the table would describe a fallback font. Aborting.");
  process.exit(1);
}

const round = (n: number) => Number(n.toFixed(4));

const body = WEIGHTS.map((w) => {
  const row = measured.out[String(w)]!;
  const entries = Object.entries(row)
    .map(([ch, adv]) => `    ${JSON.stringify(ch)}: ${round(adv)},`)
    .join("\n");
  return `  ${w}: {\n${entries}\n  },`;
}).join("\n");

// Anything outside the table (an emoji, CJK, a rare symbol) falls back to the
// mean of the lowercase letters — the distribution a label is mostly made of.
const fallbacks = WEIGHTS.map((w) => {
  const row = measured.out[String(w)]!;
  const lower = "abcdefghijklmnopqrstuvwxyz".split("").map((c) => row[c] ?? 0.5);
  return `  ${w}: ${round(lower.reduce((a, b) => a + b, 0) / lower.length)},`;
}).join("\n");

writeFileSync(
  OUT,
  `/**
 * Inter advance widths as a fraction of font-size, measured in Chromium.
 *
 * GENERATED by scripts/gen-font-metrics.ts — do not edit by hand. Regenerate
 * when the bundled font files in backend/assets/fonts change.
 *
 * Used only by the fallback measurer (measureByMetrics), which stands in when
 * Chromium is unavailable and cross-checks it when it is. The browser is always
 * preferred: summing advances here ignores kerning, so a long label drifts by
 * up to about a percent, which is why collision rules allow more slack on a
 * metrics measurement than on a browser one.
 */

export const INTER_ADVANCES: Readonly<Record<number, Readonly<Record<string, number>>>> = Object.freeze({
${body}
});

/** Mean lowercase advance, for codepoints outside the table. */
export const INTER_FALLBACK_ADVANCE: Readonly<Record<number, number>> = Object.freeze({
${fallbacks}
});

/** Weights the table covers; anything else snaps to the nearest of these. */
export const INTER_WEIGHTS = [${WEIGHTS.join(", ")}] as const;

/**
 * Vertical extent of inked text relative to its baseline, in em. A label drawn
 * at baseline \`y\` with font-size \`s\` inks from \`y - ASCENT*s\` to \`y + DESCENT*s\`.
 */
export const INTER_ASCENT = ${round(vertical.ascent)};
export const INTER_DESCENT = ${round(vertical.descent)};

/**
 * How far \`dominant-baseline="middle"\` moves the box down, in em. The diagram
 * prompt requires this attribute on anything centred inside a shape, so the
 * fallback measurer gets it wrong for most labels without this.
 */
export const INTER_MIDDLE_SHIFT = ${round(vertical.middleShift)};
`,
  "utf8",
);

const sample = measured.out["400"]!;
console.log(`Wrote ${OUT}`);
console.log(`  ${CHARS.length} chars x ${WEIGHTS.length} weights`);
console.log(`  sanity: W=${round(sample["W"]!)}em  i=${round(sample["i"]!)}em  space=${round(sample[" "]!)}em`);
console.log(`  the flat ratio this replaces assumed 0.55em for every one of them`);
console.log(
  `  vertical: ascent=${round(vertical.ascent)}em descent=${round(vertical.descent)}em ` +
    `middle-shift=${round(vertical.middleShift)}em`,
);
