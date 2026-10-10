/**
 * Generates ONE real lecture and prints its shape: sections, kinds, block mix,
 * whether code can run and diagrams can be drawn part by part, and a sample of
 * the tutor instructions. Spends real LLM budget — not a test.
 *
 *   npx tsx scripts/probe-lecture.ts [bn]
 */
import { writeFileSync } from "node:fs";
import { makeLecture, type LessonContext } from "../src/agents/lecture-maker/index.js";
import { revealBlocker } from "../src/agents/lecture-maker/revealable.js";
import { withTokenLedger } from "../src/agents/shared/tokenLedger.js";

const CTX: LessonContext = {
  lessonId: "probe-python-loops",
  courseTitle: "Python Foundations",
  courseDesc: "A first course in Python programming.",
  level: "Beginner",
  chapterTitle: "Control and functions",
  moduleTitle: "Repetition",
  topicTitle: "for and while loops",
  topicBrief:
    "Teach for loops over lists and range(), while loops with a condition, how to choose between them, and the off-by-one and infinite-loop mistakes. Build one running example: totalling a shopping cart.",
  siblingTopics: ["Conditions", "Functions"],
  language: process.argv[2] === "bn" ? "bn" : "en",
};

const started = Date.now();
const lecture = await withTokenLedger("probe", () =>
  makeLecture(CTX, undefined, (e) => console.log(`  [${((Date.now() - started) / 1000).toFixed(0)}s] ${JSON.stringify(e)}`)),
);
writeFileSync("probe-lecture.json", JSON.stringify(lecture, null, 2));

console.log(`\n=== "${lecture.title}" — ${lecture.sections.length} sections in ${((Date.now() - started) / 1000).toFixed(0)}s`);
for (const s of lecture.sections) {
  const types = s.blocks.map((b) => b.type).join(",");
  console.log(`  ${s.id} [${s.kind.padEnd(9)}] t${s.topicId} ${s.title}  {${types}}`);
}

const blocks = lecture.sections.flatMap((s) => s.blocks as Array<Record<string, unknown>>);
console.log("\n=== CODE — runnable?");
for (const b of blocks.filter((x) => x.type === "code")) {
  console.log(`  language=${String(b.language ?? "(MISSING)")} lines=${String(b.code ?? "").split("\n").length}`);
}
console.log("\n=== DIAGRAMS — drawable part by part?");
for (const b of blocks.filter((x) => x.type === "mermaid")) {
  const blocker = revealBlocker(String(b.code ?? ""));
  console.log(`  ${blocker ? "NO  " + blocker : "YES"}  ${String(b.code ?? "").split("\n")[0]}`);
}
const sample = lecture.sections.find((s) => s.kind === "practical") ?? lecture.sections[0]!;
console.log(`\n=== TUTOR sample (${sample.id} ${sample.kind}):`, JSON.stringify(sample.tutor, null, 2));
const filler = blocks.filter((b) => /\b(tip|remember|note:|don't worry|pro tip)\b/i.test(JSON.stringify(b)));
console.log(`\n=== filler-looking blocks: ${filler.length}`);
console.log("\nwrote probe-lecture.json");
