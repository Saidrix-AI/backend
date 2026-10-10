/**
 * One-off: delete every lecture older than the v3 (sections) format, and the
 * class positions that pointed into them.
 *
 * v3 replaced the flat-block (v1) and block+beat (v2) lectures with one
 * section-based format. The service already ignores older documents, so this
 * only reclaims them and clears positions that would otherwise resume a class
 * at a block index that no longer exists. Each lesson regenerates in v3 the
 * next time its classroom opens.
 *
 * Plain .mjs talking to the raw collections, like the other migrations, so it
 * runs on the production image without tsx. Idempotent.
 *
 *   node scripts/migrate-lectures-v3.mjs            # dry run: counts only
 *   node scripts/migrate-lectures-v3.mjs --apply    # delete
 */
import "dotenv/config";
import mongoose from "mongoose";

const apply = process.argv.includes("--apply");

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const lectures = db.collection("lectures");
const positions = db.collection("lecturepositions");

const old = await lectures.find({ version: { $ne: 3 } }, { projection: { lessonId: 1, title: 1, version: 1 } }).toArray();
const lessonIds = old.map((d) => d.lessonId);
const posCount = await positions.countDocuments({ lessonId: { $in: lessonIds } });

console.log(`${old.length} lecture(s) older than v3, ${posCount} class position(s) pointing into them.`);
for (const d of old) console.log(`  v${d.version ?? 1}  ${d.lessonId}  ${d.title}`);

if (apply && old.length > 0) {
  const l = await lectures.deleteMany({ lessonId: { $in: lessonIds } });
  const p = await positions.deleteMany({ lessonId: { $in: lessonIds } });
  console.log(`Deleted ${l.deletedCount} lecture(s) and ${p.deletedCount} position(s).`);
} else if (!apply) {
  console.log("Dry run — re-run with --apply to delete.");
}
await mongoose.disconnect();
