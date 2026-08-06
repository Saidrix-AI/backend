// Seeds the Lecture collection from scripts/seed-data/*.json (block format,
// contract: docs/lecture.schema.json). Idempotent: upserts by lessonId.
// Run: npx tsx scripts/seed-lectures.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/database/connect.js";
import { LectureModel } from "../src/database/models/lecture.model.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const lecturesDir = path.resolve(here, "seed-data");

const FILES = [
  "multi-agent-communication.json",
  "dom-in-react.json",
  "python-introduction.json",
];

await connectDatabase();
for (const file of FILES) {
  const raw = JSON.parse(readFileSync(path.join(lecturesDir, file), "utf8"));
  // Keep only content fields — runtime-only fields (initialProgress,
  // initialActiveId, initialCompletedIds) stay out of the DB.
  const res = await LectureModel.updateOne(
    { lessonId: raw.id },
    {
      $set: {
        version: raw.version ?? 1,
        language: raw.language ?? "en",
        course: {
          title: raw.course?.title ?? "",
          breadcrumb: raw.course?.breadcrumb ?? [],
        },
        title: raw.title,
        outline: raw.outline ?? [],
        blocks: raw.blocks ?? [],
      },
    },
    { upsert: true },
  );
  // eslint-disable-next-line no-console
  console.log(`${raw.id}: ${res.upsertedCount ? "inserted" : "updated"} (${(raw.blocks ?? []).length} blocks)`);
}
await disconnectDatabase();
