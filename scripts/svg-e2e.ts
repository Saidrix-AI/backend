import "dotenv/config";
import { writeFileSync } from "node:fs";

import { closeBrowser, inspectSvg } from "../src/agents/lecture-maker/browser.js";
import { validateSvgGeometry, validateSvgPalette } from "../src/agents/lecture-maker/geometry.js";
import { runSvgWorker } from "../src/agents/lecture-maker/workers.js";
import type { LessonContext } from "../src/agents/lecture-maker/prompt.js";
import type { PlannedBlock } from "../src/agents/lecture-maker/schema.js";

/**
 * One real diagram through the whole pipeline: LLM → render → measure → fix →
 * vision critique → repair round.
 *
 * Makes real, billed model calls, so it is a manual check rather than a test —
 * the unit and browser suites cover everything that can be verified for free.
 * Its value is proving the chain holds end to end against a live model, which
 * is how the escaped-`id="hero"`-in-a-label false positive was found.
 *
 * Run: npm run svg:e2e
 */

const ctx: LessonContext = {
  lessonId: "e2e",
  courseTitle: "Modern CSS",
  courseDesc: "Layout and selectors from first principles.",
  level: "Beginner",
  chapterTitle: "Selectors",
  moduleTitle: "Targeting elements",
  topicTitle: "Selector types",
  topicBrief:
    "Cover type, class, id and attribute selectors, show one rule of each, and warn against over-using id selectors.",
  siblingTopics: ["The cascade", "Specificity"],
};

const planned: PlannedBlock = {
  type: "svg",
  topicId: 1,
  brief:
    "Compare the three basic CSS selector types side by side — element (p), class (.card) and id (#hero) — " +
    "showing the selector syntax and what it matches. This is the drawing that previously rendered with the " +
    "selector name and its syntax printed on top of each other.",
};

console.log(`model: ${process.env.LECTURE_SVG_MODEL ?? "(default)"}`);
console.log(`render=${process.env.LECTURE_SVG_RENDER_ENABLED ?? "true"} vision=${process.env.LECTURE_SVG_VISION_ENABLED ?? "true"}\n`);

const t0 = Date.now();
const emission = await runSvgWorker(ctx, "Selector types", "Selector types", planned, "e2e-");
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

if (!emission) {
  console.error(`FAILED: no diagram produced after ${elapsed}s`);
  await closeBrowser();
  process.exit(1);
}

console.log(`produced in ${elapsed}s, ${emission.svg.length} bytes`);
console.log(`alt: ${emission.alt}\n`);

// Judge the final artefact exactly as the pipeline would.
const inspection = await inspectSvg(emission.svg, { screenshot: true });
const issues = [
  ...validateSvgGeometry(emission.svg, { idPrefix: "e2e-", alt: emission.alt, measurement: inspection?.measurement }),
  ...validateSvgPalette(emission.svg),
];

console.log(`measured by: ${inspection?.measurement.source ?? "none"} | fonts loaded: ${inspection?.fontsReady}`);
console.log(`labels: ${inspection?.measurement.elements.filter((e) => e.tagName === "text").length ?? 0}`);
console.log(issues.length === 0 ? "geometry: CLEAN" : `geometry: ${issues.length} issue(s)`);
for (const i of issues) console.log(`  - ${i}`);

writeFileSync("scripts/.e2e-out.svg", emission.svg);
if (inspection?.png) writeFileSync("scripts/.e2e-out.png", inspection.png);
console.log("\nwrote scripts/.e2e-out.svg and _e2e-out.png");

await closeBrowser();
