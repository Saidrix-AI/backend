import { describe, expect, it } from "vitest";
import { inlineSvgStyles } from "../src/agents/lecture-maker/inlineStyles.js";
import { validateSvgMarkup } from "../src/agents/lecture-maker/validate.js";

/**
 * The svg worker's most common failure was a perfectly good drawing rejected
 * for using CSS classes. These lock in the fold that rescues it.
 */
describe("inlineSvgStyles", () => {
  it("folds class rules onto matching elements and drops the stylesheet", () => {
    const { svg } = inlineSvgStyles(`<svg viewBox="0 0 700 400">
      <style>
        .box { fill: var(--card); stroke: var(--border); }
        .label { font-size: 12px; }
      </style>
      <rect class="box" x="10" y="10" width="40" height="20"/>
      <text class="label" x="20" y="30">scope</text>
    </svg>`);

    expect(svg).not.toMatch(/<style/i);
    expect(svg).toContain('style="fill: var(--card); stroke: var(--border)"');
    expect(svg).toContain('style="font-size: 12px"');
    expect(validateSvgMarkup(svg)).toEqual([]);
  });

  it("turns the real gpt-4o emission that used to be dropped into valid markup", () => {
    const emitted = `<svg viewBox="0 0 700 400" xmlns="http://www.w3.org/2000/svg">
    <style>
        .var-box {
            fill: var(--card);
            stroke: var(--border);
            stroke-width: 2;
        }
    </style>
    <rect class="var-box" x="40" y="40" width="200" height="80"/>
</svg>`;
    expect(validateSvgMarkup(emitted)).toContain("style tags are forbidden");

    const { svg } = inlineSvgStyles(emitted);
    expect(validateSvgMarkup(svg)).toEqual([]);
    expect(svg).toContain("fill: var(--card)");
    expect(svg).toContain("stroke-width: 2");
  });

  it("matches id and tag selectors, and a comma-separated list", () => {
    const { svg } = inlineSvgStyles(`<svg viewBox="0 0 10 10">
      <style>
        #main { opacity: 0.5; }
        text, tspan { fill: var(--text); }
      </style>
      <g id="main"><text x="1" y="2">a</text></g>
    </svg>`);
    expect(svg).toContain('style="opacity: 0.5"');
    expect(svg).toContain('style="fill: var(--text)"');
  });

  it("keeps the element's own inline style winning over the stylesheet", () => {
    const { svg } = inlineSvgStyles(
      `<svg viewBox="0 0 10 10"><style>.a { fill: red; }</style><rect class="a" style="fill: var(--dark)"/></svg>`,
    );
    // Later declaration wins in CSS, so the element's own must come last.
    expect(svg).toContain('style="fill: red; fill: var(--dark)"');
  });

  it("leaves markup untouched when there is no stylesheet", () => {
    const plain = '<svg viewBox="0 0 10 10"><rect fill="var(--dark)"/></svg>';
    expect(inlineSvgStyles(plain)).toEqual({ svg: plain, unsupported: false });
  });

  it("flags selectors it cannot fold instead of guessing", () => {
    const { unsupported } = inlineSvgStyles(
      `<svg viewBox="0 0 10 10"><style>.a .b { fill: red; } @media (x) { .c { fill: blue; } }</style><rect class="a"/></svg>`,
    );
    expect(unsupported).toBe(true);
  });

  it("preserves self-closing tags", () => {
    const { svg } = inlineSvgStyles(
      `<svg viewBox="0 0 10 10"><style>.a { fill: red; }</style><rect class="a" x="1"/></svg>`,
    );
    expect(svg).toContain('<rect class="a" x="1" style="fill: red"/>');
    expect(validateSvgMarkup(svg)).toEqual([]);
  });
});
