import { describe, expect, it } from "vitest";

import { validateSvgCollisions } from "../src/agents/lecture-maker/collide.js";
import { measureByMetrics } from "../src/agents/lecture-maker/measureByMetrics.js";

/**
 * Collision rules, driven through the font-metrics measurer so they run without
 * a browser. The browser path is exercised in svg-browser.test.ts; what matters
 * here is the judgement, not the measuring.
 *
 * False positives are the real risk in this file. Nesting, adjacent boxes and
 * arrows crossing shapes are all normal in these drawings, and a rule that
 * flags them would burn the repair round on correct diagrams — which is why
 * every "does not flag" case below is as load-bearing as the ones that catch.
 */

const issues = (svg: string) => validateSvgCollisions(measureByMetrics(svg));

/** The reported defect: two labels centred on the same point in one box. */
const OVERLAPPING_LABELS = `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
  <rect id="q-a" x="24" y="100" width="200" height="60" rx="10" fill="var(--dia-3-tint)" stroke="var(--dia-3)"/>
  <text id="q-a-1" x="124" y="130" text-anchor="middle" dominant-baseline="middle" font-family="Inter" font-size="13" fill="var(--dia-ink)">Element selector</text>
  <text id="q-a-2" x="124" y="130" text-anchor="middle" dominant-baseline="middle" font-family="Inter" font-size="13" fill="var(--dia-ink)">p { }</text>
</svg>`;

/** Passes every rule: nested boxes, one label each, comfortably inside. */
const CLEAN_NESTED = `<svg viewBox="0 0 700 340" xmlns="http://www.w3.org/2000/svg">
  <rect id="s1-outer" x="24" y="24" width="652" height="292" rx="10" fill="var(--dia-1-tint)" stroke="var(--dia-1)"/>
  <text id="s1-outer-label" x="40" y="50" font-family="Inter" font-size="14" fill="var(--dia-ink)" text-anchor="start">Global Scope</text>
  <rect id="s1-inner" x="64" y="146" width="592" height="146" rx="10" fill="var(--dia-2-tint)" stroke="var(--dia-2)"/>
  <text id="s1-inner-label" x="360" y="200" font-family="Inter" font-size="13" fill="var(--dia-ink)" text-anchor="middle">Function Scope</text>
</svg>`;

describe("text collisions", () => {
  it("catches two labels printed on top of each other", () => {
    const found = issues(OVERLAPPING_LABELS).join(" ");
    expect(found).toContain("Element selector");
    expect(found).toContain("p { }");
    expect(found).toContain("overlap");
  });

  it("names stacking as the fix, so the repair round has an action", () => {
    expect(issues(OVERLAPPING_LABELS).join(" ")).toContain("stack them");
  });

  it("does not flag two labels stacked in the same box", () => {
    const svg = `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
      <rect id="a" x="24" y="100" width="200" height="72" rx="10" fill="var(--dia-1-tint)"/>
      <text id="a-1" x="124" y="126" text-anchor="middle" font-family="Inter" font-size="13">Element</text>
      <text id="a-2" x="124" y="152" text-anchor="middle" font-family="Inter" font-size="11">selector</text>
    </svg>`;
    expect(issues(svg)).toEqual([]);
  });

  // Labels in adjacent columns share a baseline; only an x-range overlap is a
  // collision. An earlier draft compared baselines alone and flagged every row.
  it("does not flag labels side by side on the same row", () => {
    const svg = `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
      <text id="a" x="124" y="136" text-anchor="middle" font-family="Inter" font-size="13">Opening tag</text>
      <text id="b" x="350" y="136" text-anchor="middle" font-family="Inter" font-size="13">Content</text>
      <text id="c" x="576" y="136" text-anchor="middle" font-family="Inter" font-size="13">Closing tag</text>
    </svg>`;
    expect(issues(svg)).toEqual([]);
  });
});

describe("label overflow", () => {
  it("catches a label wider than the box holding it", () => {
    const svg = `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
      <rect id="a" x="24" y="100" width="120" height="60" rx="10" fill="var(--dia-1-tint)"/>
      <text id="a-t" x="84" y="130" text-anchor="middle" dominant-baseline="middle" font-family="Inter" font-size="13">Cascading Style Sheets</text>
    </svg>`;
    const found = issues(svg).join(" ");
    expect(found).toContain("Cascading Style Sheets");
    expect(found).toContain("overruns");
  });

  // The entity-decoding bug: `&lt;h1&gt;` is four drawn characters, not twelve.
  // Before decoding, this label measured ~93% too wide and was reported as
  // overflowing a box it fits inside with room to spare.
  it("does not flag an escaped tag label that fits", () => {
    const svg = `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
      <rect id="a" x="24" y="100" width="200" height="72" rx="10" fill="var(--dia-1-tint)"/>
      <text id="a-t" x="124" y="136" text-anchor="middle" dominant-baseline="middle" font-family="Inter" font-size="13">&lt;h1&gt;</text>
    </svg>`;
    expect(issues(svg)).toEqual([]);
  });
});

describe("box collisions", () => {
  it("does not flag a box fully nested inside another", () => {
    expect(issues(CLEAN_NESTED)).toEqual([]);
  });

  it("catches two boxes half covering each other", () => {
    const svg = `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
      <rect id="a" x="100" y="80" width="200" height="100" fill="var(--dia-1-tint)"/>
      <rect id="b" x="220" y="120" width="200" height="100" fill="var(--dia-2-tint)"/>
    </svg>`;
    expect(issues(svg).join(" ")).toContain("without one containing the other");
  });

  it("does not flag boxes that merely sit side by side", () => {
    const svg = `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
      <rect id="a" x="24" y="100" width="200" height="72" fill="var(--dia-1-tint)"/>
      <rect id="b" x="224" y="100" width="200" height="72" fill="var(--dia-2-tint)"/>
    </svg>`;
    expect(issues(svg)).toEqual([]);
  });

  it("does not flag an arrow crossing a box", () => {
    const svg = `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
      <rect id="a" x="100" y="80" width="200" height="100" fill="var(--dia-1-tint)"/>
      <line id="arrow" x1="60" y1="130" x2="400" y2="130" stroke="var(--dia-line)" stroke-width="2"/>
    </svg>`;
    expect(issues(svg)).toEqual([]);
  });
});

describe("transformed content", () => {
  // The old reader ignored `transform` entirely, so a group translated on top
  // of another shape was invisible to every check.
  it("sees a collision that only exists after a group transform", () => {
    const svg = `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
      <rect id="fixed" x="300" y="80" width="160" height="80" fill="var(--dia-1-tint)"/>
      <g transform="translate(260, 40)">
        <rect id="moved" x="100" y="60" width="160" height="80" fill="var(--dia-2-tint)"/>
      </g>
    </svg>`;
    expect(issues(svg).join(" ")).toContain("without one containing the other");
  });

  it("does not flag the same group when it is translated clear", () => {
    const svg = `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
      <rect id="fixed" x="60" y="80" width="160" height="80" fill="var(--dia-1-tint)"/>
      <g transform="translate(260, 0)">
        <rect id="moved" x="100" y="80" width="160" height="80" fill="var(--dia-2-tint)"/>
      </g>
    </svg>`;
    expect(issues(svg)).toEqual([]);
  });
});
