import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { chromium, type Browser, type Page } from "playwright-core";

import { env } from "../../config/env.js";
import type { MeasuredElement, SvgMeasurement } from "./measure.js";
import { buildHarnessHtml, CANVAS_WIDTH, ENSURE_FONTS_SCRIPT, MEASURE_SCRIPT } from "./renderPage.js";

const nodeRequire = createRequire(import.meta.url);

/**
 * Headless Chromium as the one source of truth about a diagram.
 *
 * It answers the question no amount of markup parsing can: how wide is this
 * label actually going to be. The previous approach multiplied the character
 * count by a flat 0.55 of the font size — but `i` is 0.26em and `W` is 0.87em
 * in Inter, so that was off by ±25% on real labels, and every overflow and
 * containment judgement built on top of it inherited the error.
 *
 * The whole module is written around one rule, the same one stated at
 * runSvgWorker: a dropped diagram must never sink a lecture. So every export
 * resolves to `null` on failure instead of throwing — a browser that will not
 * launch, a page that crashes, a render that wedges. The caller falls back to
 * measureByMetrics and carries on.
 */

/** Reused across diagrams; launching Chromium costs ~300ms, a page ~20ms. */
let browserPromise: Promise<Browser | null> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
/** Pages currently open, so the idle timer never closes a browser mid-render. */
let inFlight = 0;
let launchFailureLogged = false;

/** Waiters for a free slot, oldest first. */
const queue: (() => void)[] = [];
let active = 0;

/**
 * A separate, tiny budget for calls made while a class is in progress.
 *
 * The queue above is sized for a lecture BUILD, where a fifteen-second render
 * is nothing. `outlineMermaid` runs inside a POST from a voice agent while a
 * student is listening to a stall line, and queueing it behind four batch
 * renders would produce a half-minute of silence caused by an unrelated
 * background job. So the live path never queues at all: it takes one of these
 * slots or gives up, and giving up is harmless because the check is advisory.
 */
const LIVE_SLOTS = 2;
let liveActive = 0;

function acquireLive(): boolean {
  if (liveActive >= LIVE_SLOTS) return false;
  liveActive++;
  return true;
}

async function acquire(): Promise<void> {
  if (active < env.LECTURE_SVG_RENDER_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => queue.push(resolve));
  active++;
}

function release(): void {
  active--;
  queue.shift()?.();
}

/**
 * Installed browsers tried when Playwright's own download is missing. Both are
 * Chromium, and a developer machine almost always has one — while the pinned
 * headless build goes missing on every playwright-core bump. That gap turned
 * off the Mermaid syntax gate for weeks without anyone noticing: a diagram with
 * a quote in a bare label reached a live class as "could not be rendered"
 * (lesson w8q5ij2ma4-c1m2t2, block b13, 2026-09-29).
 */
const FALLBACK_CHANNELS = ["chrome", "msedge"] as const;

async function launch(): Promise<Browser | null> {
  // --disable-dev-shm-usage: on a container with a small /dev/shm Chromium
  // crashes mid-render rather than failing to start, which is far harder to
  // diagnose from a missing diagram.
  const args = ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox"];
  try {
    return await chromium.launch({
      args,
      // playwright-core ships no browser of its own, so it looks in the location
      // `playwright install` would have used. On an image that gets Chromium
      // from the system instead — the Nixpacks build does — that path does not
      // exist, and this is how the binary is pointed at. Unset elsewhere, which
      // keeps the normal `npx playwright-core install chromium` flow working.
      ...(process.env.CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
  } catch (err) {
    // An explicit path that does not work is a deployment mistake to report,
    // not one to paper over with whatever else happens to be installed.
    if (!process.env.CHROMIUM_EXECUTABLE_PATH) {
      for (const channel of FALLBACK_CHANNELS) {
        try {
          const browser = await chromium.launch({ args, channel });
          console.info(`[lecture-maker] Playwright's Chromium is missing — using the installed ${channel} instead.`);
          return browser;
        } catch {
          // Not installed either; try the next one.
        }
      }
    }
    if (!launchFailureLogged) {
      console.warn(
        "[lecture-maker] Chromium could not be launched — diagrams will be measured with the font-metrics " +
          "fallback and the vision pass skipped. Install it with `npx playwright-core install chromium` " +
          "(set PLAYWRIGHT_BROWSERS_PATH to control where), point CHROMIUM_EXECUTABLE_PATH at a system " +
          "Chromium, or set LECTURE_SVG_RENDER_ENABLED=false to " +
          `silence this. Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
      launchFailureLogged = true;
    }
    return null;
  }
}

async function getBrowser(): Promise<Browser | null> {
  if (!browserPromise) browserPromise = launch();
  const browser = await browserPromise;
  // A browser that died between diagrams (crash, OOM kill) reports disconnected;
  // relaunch once rather than failing every subsequent drawing in the lecture.
  if (browser && !browser.isConnected()) {
    browserPromise = launch();
    return browserPromise;
  }
  return browser;
}

function touchIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (inFlight > 0) {
      touchIdleTimer();
      return;
    }
    void closeBrowser();
  }, env.LECTURE_SVG_BROWSER_IDLE_MS);
  // Never hold the process open just to keep an idle browser reachable.
  idleTimer.unref?.();
}

/** Shuts the browser down. Safe to call when none is running. */
export async function closeBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  try {
    const browser = await pending;
    await browser?.close();
  } catch {
    // Closing a browser that already died is not a problem worth reporting.
  }
}

export interface InspectOptions {
  /** Also capture the PNG the vision critic looks at. */
  screenshot?: boolean;
}

export interface Inspection {
  measurement: SvgMeasurement;
  /** 2x PNG of the drawing; present only when `screenshot` was requested. */
  png?: Buffer;
  /** False when Inter did not load, so the measurement is in a fallback font. */
  fontsReady: boolean;
}

/** Shape returned by MEASURE_SCRIPT, before it becomes an SvgMeasurement. */
interface RawMeasurement {
  viewBox: { width: number; height: number };
  elements: Omit<MeasuredElement, "index">[] & { index: number }[];
  fontsReady: boolean;
}

/**
 * Renders one drawing and reads back its true geometry, optionally with the
 * matching screenshot.
 *
 * Measurement and screenshot deliberately share a single page load. It is
 * cheaper, but mainly it means the boxes the rules judge and the picture the
 * vision critic sees are the same render — there is no second renderer whose
 * output could disagree with the first.
 */
export async function inspectSvg(svg: string, opts: InspectOptions = {}): Promise<Inspection | null> {
  if (!env.LECTURE_SVG_RENDER_ENABLED) return null;

  await acquire();
  inFlight++;
  let page: Page | null = null;
  try {
    const browser = await getBrowser();
    if (!browser) return null;

    page = await browser.newPage({
      viewport: { width: CANVAS_WIDTH, height: 1024 },
      // The screenshot is 2x so the vision model can read 11px annotations,
      // the smallest the diagram prompt allows.
      deviceScaleFactor: 2,
    });
    page.setDefaultTimeout(env.LECTURE_SVG_RENDER_TIMEOUT_MS);

    await page.setContent(buildHarnessHtml(svg), {
      waitUntil: "load",
      timeout: env.LECTURE_SVG_RENDER_TIMEOUT_MS,
    });
    // Measuring before the webfont resolves is the one way to get browser
    // numbers that are confidently wrong: the glyphs measured would be the
    // fallback font's, not the ones that end up on screen.
    await page.evaluate(ENSURE_FONTS_SCRIPT);

    const raw = (await page.evaluate(MEASURE_SCRIPT)) as RawMeasurement | null;
    if (!raw) {
      // Reached when the markup produced no <svg> in the page, or the measure
      // script returned something unserialisable. Silent here once cost an
      // afternoon, so it says so.
      console.warn("[lecture-maker] diagram rendered but produced no measurable svg root");
      return null;
    }

    const measurement: SvgMeasurement = {
      viewBox: raw.viewBox,
      elements: raw.elements as MeasuredElement[],
      source: "browser",
    };

    let png: Buffer | undefined;
    if (opts.screenshot) {
      const figure = page.locator("#figure");
      png = await figure.screenshot({ type: "png" });
    }

    return { measurement, png, fontsReady: raw.fontsReady };
  } catch (err) {
    console.warn(
      `[lecture-maker] diagram render failed, falling back to estimated geometry: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  } finally {
    inFlight--;
    release();
    touchIdleTimer();
    if (page) await page.close().catch(() => {});
  }
}

/** The self-contained Mermaid UMD bundle, read once and cached. */
let mermaidBundle: string | null = null;
function mermaidScript(): string | null {
  if (mermaidBundle !== null) return mermaidBundle || null;
  try {
    // The single-file build sets window.mermaid; the ESM entry pulls in relative
    // chunks that will not resolve inside an injected <script>.
    mermaidBundle = readFileSync(nodeRequire.resolve("mermaid/dist/mermaid.min.js"), "utf8");
  } catch {
    mermaidBundle = "";
  }
  return mermaidBundle || null;
}

/**
 * Syntax-checks Mermaid diagrams in a real Mermaid instance, so a diagram that
 * would render as an error card for the student is caught at generation and sent
 * back for repair — the same role validateSvgMarkup plays for hand-drawn svg.
 *
 * Returns one entry per input: null when the code parses, else the error string.
 * Returns null (the whole array) when checking is disabled or the browser is
 * unavailable — matching the pipeline's rule that a missing browser degrades
 * gracefully rather than blocking a lecture. The frontend's RenderErrorCard is
 * the backstop either way.
 *
 * All codes are checked in one page: loading the ~3.5MB bundle per diagram would
 * dominate the cost, so it is injected once and reused across the batch.
 */
export async function parseMermaidCodes(codes: string[]): Promise<(string | null)[] | null> {
  if (!env.LECTURE_SVG_RENDER_ENABLED || codes.length === 0) return null;
  const bundle = mermaidScript();
  if (!bundle) return null;

  await acquire();
  inFlight++;
  let page: Page | null = null;
  try {
    const browser = await getBrowser();
    if (!browser) return null;
    page = await browser.newPage();
    page.setDefaultTimeout(env.LECTURE_SVG_RENDER_TIMEOUT_MS);
    await page.setContent("<!doctype html><html><body></body></html>", { waitUntil: "load" });
    await page.addScriptTag({ content: bundle });

    // Evaluated as a string (with the codes embedded) so the backend tsconfig,
    // which has no DOM lib, never has to type-check `window` — the same reason
    // MEASURE_SCRIPT is a string.
    const script = `(async () => {
      const mermaid = window.mermaid;
      const codes = ${JSON.stringify(codes)};
      if (!mermaid || !mermaid.parse) return codes.map(() => "mermaid failed to load");
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      const out = [];
      for (const code of codes) {
        try { await mermaid.parse(code); out.push(null); }
        catch (e) { out.push(((e && e.message) ? String(e.message) : "invalid Mermaid syntax").slice(0, 200)); }
      }
      return out;
    })()`;
    return (await page.evaluate(script)) as (string | null)[];
  } catch (err) {
    console.warn(
      `[lecture-maker] Mermaid validation skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    inFlight--;
    release();
    touchIdleTimer();
    if (page) await page.close().catch(() => {});
  }
}

export interface MermaidOutline {
  /** e.g. "flowchart-v2". Anything else has a different DOM id scheme. */
  diagramType: string;
  /** Node keys, read back out of the ids Mermaid actually emitted. */
  nodeKeys: string[];
  /** Edge ids in Mermaid's `L_<from>_<to>_<n>` form. */
  edgeIds: string[];
}

/** How long the live path will wait before deciding the answer is not worth it. */
const OUTLINE_TIMEOUT_MS = 3_000;

/**
 * Renders one diagram and reads back the parts a reveal can actually target.
 *
 * A separate export from `parseMermaidCodes`, not an option on it, because the
 * two have different latency budgets and nothing else: that one runs in a batch
 * lecture build where fifteen seconds is free, this one runs inside a request
 * made while a student is listening. Merging them is how one of those budgets
 * eventually gets a timeout that suits the other.
 *
 * ADVISORY, and deliberately so. It returns null whenever rendering is
 * disabled, Chromium is missing, or both live slots are busy — so it cannot be
 * the thing that guarantees a reveal plan is valid. The load-bearing check is
 * the pure parser in the voice service, which runs every time. What this adds
 * is the one thing a parser cannot know: what Mermaid *really* emitted.
 *
 * It does NOT use the font/palette harness. Node ids are assigned in the parser
 * before any layout happens, so fonts change coordinates and nothing else — and
 * skipping them also skips a `document.fonts` await worth hundreds of
 * milliseconds on a path that has three seconds in total.
 */
export async function outlineMermaid(
  code: string,
  opts: { live?: boolean } = {},
): Promise<MermaidOutline | null> {
  if (!env.LECTURE_SVG_RENDER_ENABLED || !code.trim()) return null;
  const bundle = mermaidScript();
  if (!bundle) return null;

  // Two callers with opposite budgets, and mixing them is what the live slots
  // exist to prevent. A live class never queues — it takes a reserved slot or
  // gives up, because a caller that has to wait is better served by "I don't
  // know". A lecture BUILD is the opposite: nobody is listening, the answer is
  // worth waiting for, and it must NOT take a slot the classroom is holding in
  // reserve. Defaults to live, so a new caller that forgets to think about this
  // gets the conservative budget rather than the one that can stall a class.
  const live = opts.live !== false;
  if (live) {
    if (!acquireLive()) return null;
  } else {
    await acquire();
  }

  inFlight++;
  let page: Page | null = null;
  try {
    const browser = await getBrowser();
    if (!browser) return null;
    page = await browser.newPage();
    page.setDefaultTimeout(live ? OUTLINE_TIMEOUT_MS : env.LECTURE_SVG_RENDER_TIMEOUT_MS);
    await page.setContent("<!doctype html><html><body></body></html>", { waitUntil: "load" });
    await page.addScriptTag({ content: bundle });

    // A string, like MEASURE_SCRIPT, so the backend tsconfig never has to
    // type-check `window`. The config must match the frontend's lib/mermaid.js
    // or this is measuring a different render than the one students see.
    const script = `(async () => {
      const mermaid = window.mermaid;
      if (!mermaid || !mermaid.render) return null;
      mermaid.initialize({
        startOnLoad: false, securityLevel: "strict", theme: "base",
        htmlLabels: false, flowchart: { htmlLabels: false, curve: "basis" },
      });
      const id = "outline-" + Date.now();
      const out = await mermaid.render(id, ${JSON.stringify(code)});
      const svg = out.svg;
      const nodes = [...svg.matchAll(new RegExp('id="' + id + '-flowchart-(.+?)-\\\\d+"', "g"))]
        .map((m) => m[1]);
      const edges = [...svg.matchAll(/data-id="(L_[^"]+)"/g)].map((m) => m[1]);
      return {
        diagramType: out.diagramType || "",
        nodeKeys: [...new Set(nodes)],
        edgeIds: [...new Set(edges)],
      };
    })()`;
    return (await page.evaluate(script)) as MermaidOutline | null;
  } catch (err) {
    console.warn(
      `[lecture-maker] Mermaid outline skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    inFlight--;
    if (live) liveActive--;
    else release();
    touchIdleTimer();
    if (page) await page.close().catch(() => {});
  }
}
