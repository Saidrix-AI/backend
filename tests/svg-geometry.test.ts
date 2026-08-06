import { describe, expect, it } from "vitest";
import { validateSvgGeometry, validateSvgPalette } from "../src/agents/lecture-maker/geometry.js";

/**
 * Fixtures are taken from SVGs a real lecture actually produced — every failing
 * case here shipped to a student before these checks existed.
 */

/** Passes every check: nested boxes, anchored labels, palette colours, full canvas. */
const CLEAN = `<svg viewBox="0 0 700 340" xmlns="http://www.w3.org/2000/svg">
  <rect id="s1-outer" x="24" y="24" width="652" height="292" rx="10" fill="var(--dia-1-tint)" stroke="var(--dia-1)" stroke-width="1.5"/>
  <text id="s1-outer-label" x="40" y="50" font-family="Inter" font-size="14" fill="var(--dia-ink)" text-anchor="start">Global Scope</text>
  <rect id="s1-inner" x="64" y="146" width="592" height="146" rx="10" fill="var(--dia-2-tint)" stroke="var(--dia-2)" stroke-width="1.5"/>
  <text id="s1-inner-label" x="360" y="200" font-family="Inter" font-size="13" fill="var(--dia-ink)" text-anchor="middle">Function Scope</text>
</svg>`;

const anchored = (extra: string, body: string, w = 700, h = 340) =>
  `<svg viewBox="0 0 ${w} ${h}"${extra}>${body}</svg>`;

describe("validateSvgGeometry", () => {
  it("passes a well-formed drawing", () => {
    expect(validateSvgGeometry(CLEAN, { idPrefix: "s1-" })).toEqual([]);
  });

  // The real bug: two SVGs on one page both defined id="arrowhead", and because
  // ids are document-wide the second block used the first block's marker.
  it("catches ids that skip the required prefix", () => {
    const svg = anchored(
      "",
      `<defs><marker id="arrowhead"><polygon points="0 0, 10 3.5, 0 7" fill="var(--dia-line)"/></marker></defs>
       <rect id="s4-box" x="24" y="24" width="652" height="292" fill="var(--dia-1-tint)"/>`,
    );
    const issues = validateSvgGeometry(svg, { idPrefix: "s4-" }).join(" ");
    expect(issues).toContain('must start with "s4-"');
    expect(issues).toContain("arrowhead");
  });

  // Found by running a real generation: a label reading `<section id="hero">`
  // is stored escaped, and a raw scan of the markup reported `hero` as an id
  // that broke the prefix rule. In an app teaching HTML those labels are
  // everywhere, and each false alarm cost a good drawing a repair round.
  it("does not mistake an id inside label text for a real id", () => {
    const svg = anchored(
      "",
      `<rect id="s2-box" x="24" y="100" width="300" height="60" fill="var(--dia-1-tint)"/>
       <text id="s2-t" x="174" y="130" text-anchor="middle" font-size="12" fill="var(--dia-ink)">&lt;section id="hero"&gt;</text>`,
    );
    expect(validateSvgGeometry(svg, { idPrefix: "s2-" }).join(" ")).not.toContain("must start with");
  });

  it("accepts prefixed ids without complaint", () => {
    expect(validateSvgGeometry(CLEAN, { idPrefix: "s1-" }).join(" ")).not.toContain("must start with");
  });

  it("catches an element drawn outside the viewBox", () => {
    const svg = anchored("", `<rect id="s1-a" x="600" y="20" width="300" height="100" fill="var(--dia-1)"/>`);
    expect(validateSvgGeometry(svg, { idPrefix: "s1-" }).join(" ")).toContain("outside the 700x340 viewBox");
  });

  // Measured defect: 0 text-anchor across 18 <text> elements in three drawings.
  it("catches <text> with no text-anchor", () => {
    const svg = anchored(
      "",
      `<rect id="s1-a" x="24" y="24" width="652" height="292" fill="var(--dia-1-tint)"/>
       <text id="s1-t" x="150" y="120" font-size="12" fill="var(--dia-ink)">var x</text>`,
    );
    expect(validateSvgGeometry(svg, { idPrefix: "s1-" }).join(" ")).toContain("no text-anchor");
  });

  // Measured defect: labels of 41, 53 and 58 characters. SVG text never wraps.
  it("catches an over-long label", () => {
    const svg = anchored(
      "",
      `<rect id="s1-a" x="24" y="24" width="652" height="292" fill="var(--dia-1-tint)"/>
       <text id="s1-t" x="350" y="180" font-size="11" text-anchor="middle" fill="var(--dia-ink)">'var' as a local variable declared inside of a function body</text>`,
    );
    expect(validateSvgGeometry(svg, { idPrefix: "s1-" }).join(" ")).toContain("exceed 40 characters");
  });

  it("catches a label running past the canvas edge", () => {
    const svg = anchored(
      "",
      `<rect id="s1-a" x="24" y="24" width="652" height="292" fill="var(--dia-1-tint)"/>
       <text id="s1-t" x="640" y="180" font-size="13" text-anchor="start" fill="var(--dia-ink)">visible everywhere</text>`,
    );
    expect(validateSvgGeometry(svg, { idPrefix: "s1-" }).join(" ")).toContain("past the canvas edge");
  });

  it("catches text below the legible floor", () => {
    const svg = anchored(
      "",
      `<rect id="s1-a" x="24" y="24" width="652" height="292" fill="var(--dia-1-tint)"/>
       <text id="s1-t" x="350" y="180" font-size="8" text-anchor="middle" fill="var(--dia-ink)">tiny</text>`,
    );
    expect(validateSvgGeometry(svg, { idPrefix: "s1-" }).join(" ")).toContain("below font-size 11");
  });

  // Measured defect: 700x300 canvas whose content ended at y=115 — 62% empty.
  it("catches a drawing marooned in an oversized canvas", () => {
    const svg = anchored(
      "",
      `<rect id="s1-a" x="24" y="24" width="400" height="80" fill="var(--dia-1-tint)"/>
       <text id="s1-t" x="220" y="70" font-size="13" text-anchor="middle" fill="var(--dia-ink)">Step one</text>`,
      700,
      300,
    );
    const issues = validateSvgGeometry(svg, { idPrefix: "s1-" }).join(" ");
    expect(issues).toContain("only fills");
    expect(issues).toContain("shrink the viewBox height");
  });

  it("ignores markup with no viewBox — validateSvgMarkup already reports that", () => {
    expect(validateSvgGeometry('<svg><rect x="1" y="1" width="2" height="2"/></svg>')).toEqual([]);
  });

  // Real defect: "Opening Tag" baseline y=170 on a box whose bottom edge was 170.
  it("catches a baseline sitting on its box border", () => {
    const svg = anchored(
      "",
      `<rect id="s1-box" x="24" y="100" width="200" height="70" fill="var(--dia-1-tint)"/>
       <text id="s1-t" x="124" y="170" text-anchor="middle" font-size="12" fill="var(--dia-ink)">Opening Tag</text>`,
      700,
      260,
    );
    expect(validateSvgGeometry(svg, { idPrefix: "s1-" }).join(" ")).toContain("render sliced");
  });

  it("does not flag a label properly centred inside its box", () => {
    const svg = anchored(
      "",
      `<rect id="s1-box" x="24" y="100" width="200" height="70" fill="var(--dia-1-tint)"/>
       <text id="s1-t" x="124" y="135" text-anchor="middle" dominant-baseline="middle" font-size="12" fill="var(--dia-ink)">Opening Tag</text>`,
      700,
      260,
    );
    expect(validateSvgGeometry(svg, { idPrefix: "s1-" }).join(" ")).not.toContain("render sliced");
  });

  // Real defect: `<text>s4-browser-bar</text>` — an internal id used as a caption.
  it("catches an id printed into the drawing", () => {
    const svg = anchored(
      "",
      `<rect id="s4-browser-bar" x="24" y="80" width="652" height="240" fill="var(--dia-1-tint)"/>
       <text id="s4-leak" x="88" y="200" text-anchor="start" font-size="12" fill="var(--dia-ink)">s4-browser-bar</text>`,
    );
    expect(validateSvgGeometry(svg, { idPrefix: "s4-" }).join(" ")).toContain("print an id or the alt text");
  });

  it("catches the alt text drawn into the drawing", () => {
    const alt = "A diagram of nested scope.";
    const svg = anchored(
      "",
      `<rect id="s1-a" x="24" y="24" width="652" height="280" fill="var(--dia-1-tint)"/>
       <text id="s1-t" x="350" y="200" text-anchor="middle" font-size="12" fill="var(--dia-ink)">${alt}</text>`,
    );
    expect(validateSvgGeometry(svg, { idPrefix: "s1-", alt }).join(" ")).toContain("print an id or the alt text");
  });
});

describe("validateSvgPalette", () => {
  it("accepts the diagram palette", () => {
    expect(validateSvgPalette(CLEAN)).toEqual([]);
  });

  it("rejects raw hex and named colours", () => {
    const svg = anchored("", `<rect id="s1-a" x="1" y="1" width="2" height="2" fill="#3b82f6" stroke="red"/>`);
    const issues = validateSvgPalette(svg).join(" ");
    expect(issues).toContain("#3b82f6");
    expect(issues).toContain("red");
  });

  it("rejects the app's chrome accents, which are not a data palette", () => {
    const svg = anchored("", `<rect id="s1-a" x="1" y="1" width="2" height="2" fill="var(--accent-blue)"/>`);
    expect(validateSvgPalette(svg).join(" ")).toContain("--accent-blue");
  });

  // On <animate>, fill="freeze" is the end-state behaviour, not a colour.
  it("does not mistake SMIL fill=\"freeze\" for a bad colour", () => {
    const svg = anchored(
      "",
      `<rect id="s1-a" x="24" y="24" width="200" height="60" fill="var(--dia-1-tint)">
         <animate attributeName="width" dur="3s" values="200;400" fill="freeze"/>
       </rect>`,
    );
    expect(validateSvgPalette(svg)).toEqual([]);
  });

  it("allows none, transparent and url() references", () => {
    const svg = anchored(
      "",
      `<rect id="s1-a" x="1" y="1" width="2" height="2" fill="none" stroke="transparent"/>
       <line id="s1-l" x1="1" y1="1" x2="2" y2="2" stroke="var(--dia-line)" marker-end="url(#s1-arrow)"/>`,
    );
    expect(validateSvgPalette(svg)).toEqual([]);
  });
});
