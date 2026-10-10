import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

/**
 * Renders a flowchart with the real Mermaid and writes the SVG as a test fixture.
 *
 *   npm run mermaid:fixture
 *
 * The classroom's drawing lane reveals a diagram part by part by finding node
 * groups at `id="<svgId>-flowchart-<key>-<counter>"` and edges at
 * `data-id="L_<from>_<to>_<n>"`. Those are Mermaid's internals, not a public
 * contract — a minor version bump could change either, and nothing would throw:
 * the frontend fails open and would simply stop revealing, showing every
 * diagram whole. The fixture is the canary. Regenerate it when Mermaid is
 * upgraded, and the frontend test tells you at once whether the id scheme still
 * holds.
 *
 * It lives in the backend because this is the only workspace with a browser.
 * It writes into the frontend because that is where the test that reads it is.
 */

const require = createRequire(import.meta.url);
const bundle = readFileSync(require.resolve("mermaid/dist/mermaid.min.js"), "utf8");

// fileURLToPath, not URL.pathname — the latter is percent-encoded, so a
// project directory with a space in its name silently writes to a "%20" path.
const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "frontend",
  "tests",
  "fixtures",
  "flowchart.svg",
);

// Deliberately exercises the awkward cases: a decision node, a label containing
// punctuation, a cylinder shape, edge labels, and a node reached by two edges.
const SOURCE = `flowchart TD
  Client[Browser sends a request] --> Edge{In the cache?}
  Edge -->|yes| Cache[(Redis)]
  Edge -->|no| Origin[Origin server]
  Origin --> Cache
`;

const browser = await chromium.launch({
  args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox"],
  ...(process.env.CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
    : {}),
});
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>", { waitUntil: "load" });
await page.addScriptTag({ content: bundle });

// Must match lib/mermaid.js, or the fixture is not what the app renders.
const result = await page.evaluate(async (code) => {
  const m = window.mermaid;
  m.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    htmlLabels: false,
    flowchart: { htmlLabels: false, curve: "basis" },
  });
  const { svg, diagramType } = await m.render("mermaid-fixture", code);
  return { svg, diagramType };
}, SOURCE);

await browser.close();

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, result.svg, "utf8");

const nodeIds = [...result.svg.matchAll(/<g class="node[^"]*" id="([^"]+)"/g)].map((m) => m[1]);
const edgeIds = [...result.svg.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
console.log(`[mermaid-fixture] ${result.diagramType}, ${result.svg.length} bytes -> ${OUT}`);
console.log(`[mermaid-fixture] nodes: ${nodeIds.join(", ")}`);
console.log(`[mermaid-fixture] edges: ${[...new Set(edgeIds)].join(", ")}`);
