/**
 * Re-derives COURSE icons from their titles.
 *
 * Courses generated before the brand-icon registry existed could only pick from
 * 24 generic glyphs, so "React Fundamentals" ended up as a book. This walks the
 * existing rows and applies the same `refineIcon` rule the Course-maker now uses
 * at create time.
 *
 * DRY RUN BY DEFAULT — prints what would change and writes nothing.
 *   npm run icons:backfill            # preview
 *   npm run icons:backfill -- --apply # write
 *
 * A deliberate brand pick is never overwritten (refineIcon keeps it), so running
 * this twice is a no-op.
 *
 * PROJECTS ARE DELIBERATELY EXCLUDED. Every project inside one course shares that
 * course's technology, so inferring from titles collapses a whole course's
 * projects onto one logo — "Error Hunter", "Array Analyzer" and "To-Do List" all
 * become the JavaScript mark. Their varied generic glyphs are what tells them
 * apart on the projects page, so the planner's per-project choice stands.
 */
import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { CourseModel } from "../src/database/models/course.model.js";
import { refineIcon } from "../src/services/iconInference.js";

const APPLY = process.argv.includes("--apply");

type Row = { _id: unknown; title: string; icon?: string };

await mongoose.connect(env.MONGODB_URI);

// Title only — the same signal the create-time path uses, and for the same
// reason (see ids.ts): descriptions name adjacent technologies and mis-infer.
const rows = (await CourseModel.find({}, { title: 1, icon: 1 }).lean()) as unknown as Row[];
const changes = rows
  .map((r) => ({ id: r._id, title: r.title, from: r.icon ?? "(unset)", to: refineIcon(r.icon, r.title) }))
  .filter((c) => c.from !== c.to);

console.log(`Courses: ${rows.length} total, ${changes.length} would change`);
for (const c of changes) {
  console.log(`  ${String(c.from).padEnd(10)} → ${String(c.to).padEnd(12)} ${c.title.slice(0, 52)}`);
}

if (APPLY && changes.length) {
  await CourseModel.bulkWrite(
    changes.map((c) => ({ updateOne: { filter: { _id: c.id }, update: { $set: { icon: c.to } } } })),
  );
  console.log(`\nDone — ${changes.length} course(s) updated.`);
} else if (!APPLY) {
  console.log(`\nDry run — nothing written. Re-run with --apply to write.`);
}

await mongoose.disconnect();
