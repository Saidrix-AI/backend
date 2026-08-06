import "dotenv/config";

import { closeBrowser, inspectSvg } from "../src/agents/lecture-maker/browser.js";
import { measureByMetrics } from "../src/agents/lecture-maker/measureByMetrics.js";
import type { MeasuredElement } from "../src/agents/lecture-maker/measure.js";

/**
 * Drift canary: measures a corpus both ways and reports the disagreement.
 *
 * The font-metrics fallback only has value while it still resembles the
 * browser. This is what turns the silent failures into a number — Inter
 * stopping loading, the bundled font files changing, a transform case the
 * walker gets wrong — instead of leaving them to show up as mysteriously bad
 * diagrams weeks later.
 *
 * Run: npx tsx scripts/svg-audit.ts
 */

/** Widest tolerated text-width error before the fallback counts as broken. */
const MAX_TEXT_DRIFT_PCT = 2;

interface Fixture {
  name: string;
  svg: string;
}

const FIXTURES: Fixture[] = [
  {
    // Straight from the diagram prompt's own worked example.
    name: "anatomy-of-an-element",
    svg: `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
  <text id="P-title" x="350" y="56" text-anchor="middle" font-family="Inter" font-size="14" fill="var(--dia-ink)">Anatomy of an element</text>
  <rect id="P-a" x="24" y="100" width="200" height="72" rx="10" fill="var(--dia-1-tint)" stroke="var(--dia-1)" stroke-width="1.5"/>
  <text id="P-a-t" x="124" y="136" text-anchor="middle" dominant-baseline="middle" font-family="Inter" font-size="13" fill="var(--dia-ink)">&lt;h1&gt;</text>
  <text id="P-a-c" x="124" y="200" text-anchor="middle" font-family="Inter" font-size="11" fill="var(--dia-ink-soft)">Opening tag</text>
  <rect id="P-b" x="250" y="100" width="200" height="72" rx="10" fill="var(--dia-2-tint)" stroke="var(--dia-2)" stroke-width="1.5"/>
  <text id="P-b-t" x="350" y="136" text-anchor="middle" dominant-baseline="middle" font-family="Inter" font-size="13" fill="var(--dia-ink)">Hello World</text>
</svg>`,
  },
  {
    name: "nested-scopes",
    svg: `<svg viewBox="0 0 700 340" xmlns="http://www.w3.org/2000/svg">
  <rect id="s1-outer" x="24" y="24" width="652" height="292" rx="10" fill="var(--dia-1-tint)" stroke="var(--dia-1)" stroke-width="1.5"/>
  <text id="s1-outer-label" x="40" y="50" font-family="Inter" font-size="14" fill="var(--dia-ink)" text-anchor="start">Global Scope</text>
  <rect id="s1-inner" x="64" y="146" width="592" height="146" rx="10" fill="var(--dia-2-tint)" stroke="var(--dia-2)" stroke-width="1.5"/>
  <text id="s1-inner-label" x="360" y="200" font-family="Inter" font-size="13" fill="var(--dia-ink)" text-anchor="middle">Function Scope</text>
</svg>`,
  },
  {
    // The reported defect: two labels centred on the same point.
    name: "overlapping-selector-labels",
    svg: `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
  <rect id="q-a" x="24" y="100" width="200" height="60" rx="10" fill="var(--dia-3-tint)" stroke="var(--dia-3)" stroke-width="1.5"/>
  <text id="q-a-1" x="124" y="130" text-anchor="middle" dominant-baseline="middle" font-family="Inter" font-size="13" fill="var(--dia-ink)">Element selector</text>
  <text id="q-a-2" x="124" y="130" text-anchor="middle" dominant-baseline="middle" font-family="Inter" font-size="13" fill="var(--dia-ink)">p { }</text>
</svg>`,
  },
  {
    // Grouped + rotated content, the case the old reader could not see at all.
    name: "transformed-group",
    svg: `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(120, 40)">
    <rect id="g-a" x="40" y="30" width="160" height="60" fill="var(--dia-1-tint)" stroke="var(--dia-1)"/>
    <text id="g-a-t" x="120" y="65" text-anchor="middle" font-family="Inter" font-size="12" fill="var(--dia-ink)">Grouped label</text>
    <g transform="scale(1.5)">
      <rect id="g-b" x="20" y="80" width="80" height="30" fill="var(--dia-2)"/>
    </g>
  </g>
  <g transform="rotate(15 350 200)">
    <rect id="g-c" x="300" y="180" width="100" height="40" fill="var(--dia-4-tint)" stroke="var(--dia-4)"/>
  </g>
</svg>`,
  },
];

interface Drift {
  fixture: string;
  id: string;
  tagName: string;
  text?: string;
  browserW: number;
  metricsW: number;
  pct: number;
  dx: number;
  dy: number;
}

const drifts: Drift[] = [];
const missing: string[] = [];
let comparedTexts = 0;

for (const fixture of FIXTURES) {
  const inspection = await inspectSvg(fixture.svg);
  if (!inspection) {
    console.error(`Could not render ${fixture.name} — is Chromium installed?`);
    process.exit(1);
  }
  if (!inspection.fontsReady) {
    console.error(`Inter did not load while rendering ${fixture.name}; every number below would be meaningless.`);
    process.exit(1);
  }

  const fallback = measureByMetrics(fixture.svg);
  const byId = new Map<string, MeasuredElement>();
  for (const el of fallback.elements) if (el.id) byId.set(el.id, el);

  for (const b of inspection.measurement.elements) {
    if (!b.id) continue;
    const m = byId.get(b.id);
    if (!m) {
      missing.push(`${fixture.name}/${b.id} (${b.tagName})`);
      continue;
    }
    const browserW = b.box.maxX - b.box.minX;
    const metricsW = m.box.maxX - m.box.minX;
    const pct = browserW > 0 ? (Math.abs(metricsW - browserW) / browserW) * 100 : 0;
    if (b.tagName === "text") comparedTexts++;
    drifts.push({
      fixture: fixture.name,
      id: b.id,
      tagName: b.tagName,
      text: b.text,
      browserW,
      metricsW,
      pct,
      dx: m.box.minX - b.box.minX,
      dy: m.box.minY - b.box.minY,
    });
  }
}

await closeBrowser();

console.log("browser vs font-metrics fallback\n");
console.log("fixture                        id              tag    browser  metrics   drift    dx     dy");
console.log("-".repeat(94));
for (const d of drifts) {
  console.log(
    `${d.fixture.slice(0, 29).padEnd(30)} ${d.id.padEnd(15)} ${d.tagName.padEnd(6)} ` +
      `${d.browserW.toFixed(1).padStart(7)} ${d.metricsW.toFixed(1).padStart(8)} ` +
      `${d.pct.toFixed(2).padStart(6)}% ${d.dx.toFixed(1).padStart(6)} ${d.dy.toFixed(1).padStart(6)}`,
  );
}

const texts = drifts.filter((d) => d.tagName === "text");
const worst = texts.reduce<Drift | null>((a, b) => (!a || b.pct > a.pct ? b : a), null);
const mean = texts.length ? texts.reduce((s, d) => s + d.pct, 0) / texts.length : 0;

console.log("");
console.log(`compared ${drifts.length} elements (${comparedTexts} labels) across ${FIXTURES.length} fixtures`);
console.log(`text width drift: mean ${mean.toFixed(2)}%, worst ${worst?.pct.toFixed(2) ?? "0"}% (${worst?.text ?? "-"})`);
if (missing.length) console.log(`fallback did not measure: ${missing.join(", ")}`);

if (worst && worst.pct > MAX_TEXT_DRIFT_PCT) {
  console.error(`\nFAIL: worst text drift ${worst.pct.toFixed(2)}% exceeds ${MAX_TEXT_DRIFT_PCT}%`);
  process.exit(1);
}
console.log(`\nOK: within ${MAX_TEXT_DRIFT_PCT}%`);
