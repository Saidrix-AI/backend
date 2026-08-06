import { existsSync } from "node:fs";

import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { measureByMetrics } from "../src/agents/lecture-maker/measureByMetrics.js";
import type { Inspection } from "../src/agents/lecture-maker/browser.js";

/**
 * The browser measurement path, end to end.
 *
 * Rendering is disabled for the rest of the suite (tests/setup.ts) so unit
 * tests never launch Chromium; this file turns it back on for itself, and skips
 * cleanly when no browser is installed so a fresh checkout still runs green.
 *
 * The load-bearing assertion is the font one. Everything in this feature rests
 * on Inter being the font that actually renders — if it silently fell back to
 * the platform default, every measurement would still look plausible and every
 * one of them would be wrong.
 */

type BrowserModule = typeof import("../src/agents/lecture-maker/browser.js");

let inspectSvg: BrowserModule["inspectSvg"];
let closeBrowser: BrowserModule["closeBrowser"];

/**
 * Decided at collection time, so a machine without Chromium reports these as
 * *skipped* rather than passed. An earlier version guarded inside each test
 * body and returned early, which quietly turned the whole file green while
 * asserting nothing — the failure mode worth avoiding here above all others.
 */
const chromiumAvailable = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const PROBE = `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
  <rect id="p-box" x="24" y="100" width="200" height="72" fill="var(--dia-1-tint)"/>
</svg>`;

beforeAll(async () => {
  // env.ts parses process.env at import time, so the flags have to be set and
  // the module registry reset before browser.js is pulled in.
  process.env.LECTURE_SVG_RENDER_ENABLED = "true";
  process.env.LECTURE_SVG_VISION_ENABLED = "false";
  vi.resetModules();
  ({ inspectSvg, closeBrowser } = await import("../src/agents/lecture-maker/browser.js"));
}, 60_000);

afterAll(async () => {
  if (closeBrowser) await closeBrowser();
});

const measure = async (svg: string, screenshot = false): Promise<Inspection> => {
  const result = await inspectSvg(svg, { screenshot });
  expect(result).not.toBeNull();
  return result!;
};

describe.skipIf(!chromiumAvailable)("browser measurement", () => {
  it("loads Inter rather than the platform fallback", async () => {
    const { fontsReady } = await measure(PROBE);
    expect(fontsReady).toBe(true);
  });

  // The defect this whole feature exists to fix: a flat per-character ratio
  // scored these two labels identically at 71.5 units.
  it("measures wide and narrow glyphs differently", async () => {
    const svg = `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
      <text id="w" x="150" y="130" text-anchor="middle" font-family="Inter" font-size="13">WWWWWWWWWW</text>
      <text id="i" x="500" y="130" text-anchor="middle" font-family="Inter" font-size="13">iiiiiiiiii</text>
    </svg>`;
    const { measurement } = await measure(svg);
    const wide = measurement.elements.find((e) => e.id === "w")!;
    const thin = measurement.elements.find((e) => e.id === "i")!;
    const widthOf = (e: typeof wide) => e.box.maxX - e.box.minX;
    expect(widthOf(wide) / widthOf(thin)).toBeGreaterThan(3);
  });

  it("resolves nested group transforms", async () => {
    const svg = `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
      <g transform="translate(100, 40)">
        <rect id="moved" x="500" y="60" width="80" height="40" fill="var(--dia-2)"/>
      </g>
    </svg>`;
    const { measurement } = await measure(svg);
    const moved = measurement.elements.find((e) => e.id === "moved")!;
    expect(moved.box.minX).toBeCloseTo(600, 1);
    expect(moved.box.minY).toBeCloseTo(100, 1);
  });

  it("reports browser as the measurement source", async () => {
    const { measurement } = await measure(PROBE);
    expect(measurement.source).toBe("browser");
  });

  it("captures a screenshot when asked", async () => {
    const { png } = await measure(PROBE, true);
    expect(png).toBeDefined();
    // PNG magic number, so a zero-length or HTML error body cannot pass.
    expect(png!.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});

describe.skipIf(!chromiumAvailable)("font-metrics fallback tracks the browser", () => {
  // The drift canary, as a test. A jump here means Inter stopped loading, the
  // bundled font files changed, or the transform walker regressed — all of
  // which otherwise surface only as mysteriously bad diagrams, much later.
  it("stays within 2% of measured text width", async () => {
    const svg = `<svg viewBox="0 0 700 260" xmlns="http://www.w3.org/2000/svg">
      <text id="a" x="350" y="56" text-anchor="middle" font-family="Inter" font-size="14">Anatomy of an element</text>
      <text id="b" x="124" y="136" text-anchor="middle" font-family="Inter" font-size="13">Hello World</text>
      <text id="c" x="124" y="200" text-anchor="middle" font-family="Inter" font-size="11">Opening tag</text>
      <text id="d" x="400" y="200" text-anchor="middle" font-family="Inter" font-size="13">&lt;h1&gt;</text>
    </svg>`;
    const { measurement } = await measure(svg);
    const fallback = measureByMetrics(svg);

    for (const browserEl of measurement.elements) {
      const fallbackEl = fallback.elements.find((e) => e.id === browserEl.id);
      expect(fallbackEl, `fallback did not measure ${browserEl.id}`).toBeDefined();
      const browserW = browserEl.box.maxX - browserEl.box.minX;
      const fallbackW = fallbackEl!.box.maxX - fallbackEl!.box.minX;
      const drift = Math.abs(fallbackW - browserW) / browserW;
      expect(drift, `${browserEl.id} ("${browserEl.text}") drifted ${(drift * 100).toFixed(1)}%`).toBeLessThan(0.02);
    }
  });
});
