import { describe, expect, it } from "vitest";
import { fixSvg } from "../src/agents/lecture-maker/fixSvg.js";
import { validateSvgGeometry } from "../src/agents/lecture-maker/geometry.js";

/**
 * Every fixture here is lifted from markup a real lecture shipped to a student.
 * A cheap svg model cannot act on a prose description of these defects, so they
 * are repaired in code — these lock in that repair.
 */

/** Clean drawing: nested boxes, anchored labels, everything on-canvas. */
const CLEAN = `<svg viewBox="0 0 700 340" xmlns="http://www.w3.org/2000/svg">
  <rect id="s1-outer" x="24" y="24" width="652" height="292" rx="10" fill="var(--dia-1-tint)" stroke="var(--dia-1)" stroke-width="1.5"/>
  <text id="s1-label" x="350" y="180" text-anchor="middle" font-family="Inter" font-size="14" fill="var(--dia-ink)">Global Scope</text>
</svg>`;

describe("fixSvg", () => {
  it("leaves a correct drawing byte-identical", () => {
    const { svg, repairs } = fixSvg(CLEAN);
    expect(svg).toBe(CLEAN);
    expect(repairs).toEqual([]);
  });

  it("ignores markup with no viewBox rather than guessing a canvas", () => {
    const noViewBox = '<svg><text x="10" y="20">hi</text></svg>';
    expect(fixSvg(noViewBox).svg).toBe(noViewBox);
  });

  // Real defect: `<text …>s4-browser-bar</text>` rendered as a visible caption.
  it("removes an id string printed as a caption", () => {
    const svg = `<svg viewBox="0 0 700 340">
      <rect id="s4-browser-bar" x="24" y="80" width="652" height="40" fill="var(--dia-1-tint)"/>
      <text id="s4-leak" x="88" y="106" text-anchor="start" font-size="11" fill="var(--dia-ink)">s4-browser-bar</text>
    </svg>`;
    const { svg: fixed, repairs } = fixSvg(svg);
    expect(fixed).not.toContain(">s4-browser-bar<");
    expect(fixed).toContain('id="s4-browser-bar"'); // the rect's id itself survives
    expect(repairs.join()).toContain("removed leaked text");
  });

  // Real defect: the alt text drawn into the picture as "Alt: An example of…".
  it("removes the alt text drawn into the canvas", () => {
    const alt = "An example of a basic HTML element containing an opening tag.";
    const svg = `<svg viewBox="0 0 700 340">
      <rect id="s1-a" x="24" y="24" width="652" height="200" fill="var(--dia-1-tint)"/>
      <text id="s1-alt" x="350" y="300" text-anchor="middle" font-size="11" fill="var(--dia-ink-soft)">${alt}</text>
    </svg>`;
    const { svg: fixed, repairs } = fixSvg(svg, { alt });
    expect(fixed).not.toContain(alt);
    expect(repairs.join()).toContain("removed leaked text");
  });

  it("removes the alt text even behind an 'Alt:' prefix", () => {
    const alt = "a diagram of scope";
    const svg = `<svg viewBox="0 0 700 340">
      <rect id="s1-a" x="24" y="24" width="652" height="200" fill="var(--dia-1-tint)"/>
      <text id="s1-alt" x="350" y="300" text-anchor="middle" font-size="11" fill="var(--dia-ink)">Alt: ${alt}</text>
    </svg>`;
    expect(fixSvg(svg, { alt }).svg).not.toContain("Alt: a diagram");
  });

  // A real HTML lecture labels a box "alt: accessibility"; an earlier version
  // of this pass deleted it because it began with "alt:".
  it("keeps a legitimate label that merely starts with 'alt:'", () => {
    const svg = `<svg viewBox="0 0 700 340">
      <rect id="s1-a" x="24" y="24" width="652" height="280" fill="var(--dia-1-tint)"/>
      <text id="s1-t" x="350" y="180" text-anchor="middle" font-size="12" fill="var(--dia-ink)">alt: accessibility</text>
    </svg>`;
    const { svg: fixed, repairs } = fixSvg(svg, { alt: "A totally different description." });
    expect(fixed).toContain("alt: accessibility");
    expect(repairs.join()).not.toContain("removed leaked text");
  });

  // Centring a lone line inside a 440px container would look absurd — it is
  // nudged clear of the edge instead, keeping its place in the column.
  it("nudges a line clear of a large container edge rather than centring it", () => {
    const svg = `<svg viewBox="0 0 700 520">
      <rect id="s4-outer" x="48" y="40" width="604" height="440" rx="10" fill="var(--dia-1-tint)" stroke="var(--dia-1)"/>
      <text id="s4-t" x="100" y="478" text-anchor="start" font-size="12" fill="var(--dia-ink)">&lt;/ul&gt;</text>
    </svg>`;
    const { svg: fixed, repairs } = fixSvg(svg);
    expect(repairs.join()).toContain("nudged");
    expect(fixed).toContain('y="466"'); // 480 - 14 padding, not the box centre
    expect(fixed).not.toContain('y="260"');
  });

  // Real defect: "Opening Tag" baseline y=170 on a box whose bottom edge was 170.
  it("lifts a baseline sitting exactly on its box border to the box centre", () => {
    const svg = `<svg viewBox="0 0 700 260">
      <rect id="s1-box" x="24" y="100" width="200" height="70" rx="10" fill="var(--dia-1-tint)" stroke="var(--dia-1)"/>
      <text id="s1-t" x="124" y="170" text-anchor="middle" font-size="12" fill="var(--dia-ink)">Opening Tag</text>
    </svg>`;
    const { svg: fixed, repairs } = fixSvg(svg);
    expect(fixed).toContain('y="135"'); // 100 + 70/2
    expect(fixed).toContain('dominant-baseline="middle"');
    expect(repairs.join()).toContain("centred");
    expect(validateSvgGeometry(fixed, { idPrefix: "s1-" }).join(" ")).not.toContain("render sliced");
  });

  // Real defect: left-rail labels at text-anchor="end" x="30" started at x=-31.
  it("pulls an off-canvas left-rail label back inside the safe margin", () => {
    const svg = `<svg viewBox="0 0 700 520">
      <rect id="s4-body" x="140" y="24" width="536" height="472" fill="var(--dia-1-tint)"/>
      <text id="s4-l" x="30" y="150" text-anchor="end" font-size="11" fill="var(--dia-ink-soft)">h1 heading</text>
    </svg>`;
    const { svg: fixed, repairs } = fixSvg(svg);
    expect(fixed).toContain('text-anchor="start"');
    expect(fixed).toContain('x="24"');
    expect(repairs.join()).toContain("back inside the canvas");
    const issues = validateSvgGeometry(fixed, { idPrefix: "s4-" }).join(" ");
    expect(issues).not.toContain("past the canvas edge");
  });

  it("pulls a label overhanging the right edge back in", () => {
    const svg = `<svg viewBox="0 0 700 340">
      <rect id="s1-a" x="24" y="24" width="652" height="292" fill="var(--dia-1-tint)"/>
      <text id="s1-t" x="660" y="180" text-anchor="start" font-size="13" fill="var(--dia-ink)">visible everywhere</text>
    </svg>`;
    const { svg: fixed } = fixSvg(svg);
    expect(fixed).toContain('text-anchor="end"');
    expect(validateSvgGeometry(fixed, { idPrefix: "s1-" }).join(" ")).not.toContain("past the canvas edge");
  });

  it("adds a missing text-anchor, choosing middle for a label centred on a box", () => {
    const svg = `<svg viewBox="0 0 700 340">
      <rect id="s1-box" x="250" y="100" width="200" height="72" fill="var(--dia-1-tint)"/>
      <text id="s1-t" x="350" y="136" font-size="12" fill="var(--dia-ink)">Centred</text>
      <text id="s1-u" x="40" y="300" font-size="12" fill="var(--dia-ink)">Left rail</text>
    </svg>`;
    const { svg: fixed } = fixSvg(svg);
    expect(fixed).toMatch(/<text id="s1-t"[^>]*text-anchor="middle"/);
    expect(fixed).toMatch(/<text id="s1-u"[^>]*text-anchor="start"/);
  });

  it("centres a label too wide for the canvas instead of shoving it off an edge", () => {
    const long = "a".repeat(120);
    const svg = `<svg viewBox="0 0 700 340">
      <rect id="s1-a" x="24" y="24" width="652" height="292" fill="var(--dia-1-tint)"/>
      <text id="s1-t" x="600" y="180" text-anchor="start" font-size="14" fill="var(--dia-ink)">${long}</text>
    </svg>`;
    const { svg: fixed } = fixSvg(svg);
    expect(fixed).toContain('text-anchor="middle"');
    expect(fixed).toContain('x="350"');
  });

  it("repairs every defect in one pass", () => {
    const alt = "A webpage structure diagram.";
    const svg = `<svg viewBox="0 0 700 340">
      <rect id="s4-box" x="140" y="100" width="400" height="70" rx="10" fill="var(--dia-1-tint)" stroke="var(--dia-1)"/>
      <text id="s4-rail" x="30" y="150" text-anchor="end" font-size="11" fill="var(--dia-ink-soft)">p paragraph</text>
      <text id="s4-in" x="340" y="170" text-anchor="middle" font-size="12" fill="var(--dia-ink)">Content</text>
      <text id="s4-leak" x="350" y="300" text-anchor="middle" font-size="11" fill="var(--dia-ink-soft)">${alt}</text>
    </svg>`;
    const { svg: fixed, repairs } = fixSvg(svg, { alt });
    expect(repairs.length).toBeGreaterThanOrEqual(3);
    expect(fixed).not.toContain(alt);
    const issues = validateSvgGeometry(fixed, { idPrefix: "s4-", alt }).join(" ");
    expect(issues).not.toContain("past the canvas edge");
    expect(issues).not.toContain("render sliced");
    expect(issues).not.toContain("print an id or the alt text");
  });
});

/**
 * The reported defect, and the reason the collision rules exist: one box with
 * two labels at the same anchor, painted over each other and shipped.
 */
describe("labels sharing one anchor point", () => {
  const OVERLAPPING = `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
  <rect id="q-a" x="24" y="100" width="200" height="60" rx="10" fill="var(--dia-3-tint)" stroke="var(--dia-3)"/>
  <text id="q-a-1" x="124" y="130" text-anchor="middle" dominant-baseline="middle" font-family="Inter" font-size="13" fill="var(--dia-ink)">Element selector</text>
  <text id="q-a-2" x="124" y="130" text-anchor="middle" dominant-baseline="middle" font-family="Inter" font-size="13" fill="var(--dia-ink)">p { }</text>
</svg>`;

  it("separates them and says so", () => {
    const { svg, repairs } = fixSvg(OVERLAPPING);
    expect(repairs.join(" ")).toContain("shared one anchor point");
    expect(svg).not.toBe(OVERLAPPING);
  });

  it("leaves the drawing free of the collision it was reported for", () => {
    const { svg } = fixSvg(OVERLAPPING);
    expect(validateSvgGeometry(svg, { idPrefix: "q-" }).join(" ")).not.toContain("overlap");
  });

  it("moves both labels, not just the first", () => {
    const { svg } = fixSvg(OVERLAPPING);
    const ys = [...svg.matchAll(/<text[^>]*\sy="(\d+)"/g)].map((m) => Number(m[1]));
    expect(ys).toHaveLength(2);
    expect(ys[0]).not.toBe(ys[1]);
    // Stacked around the original centre, not shunted off in one direction.
    expect((ys[0]! + ys[1]!) / 2).toBeCloseTo(130, 0);
  });

  it("does not disturb labels that merely sit near each other", () => {
    const svg = `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
      <rect id="a" x="24" y="100" width="200" height="72" rx="10" fill="var(--dia-1-tint)"/>
      <text id="a-1" x="124" y="126" text-anchor="middle" font-family="Inter" font-size="13">Element</text>
      <text id="a-2" x="124" y="152" text-anchor="middle" font-family="Inter" font-size="11">selector</text>
    </svg>`;
    expect(fixSvg(svg).svg).toBe(svg);
  });
});
