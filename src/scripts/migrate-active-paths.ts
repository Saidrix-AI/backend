/**
 * Moves `user.activePathId` (one path) to `user.activePathIds` (a list).
 *
 * Paid plans allow 1-3 learning paths active at once, so the single pointer
 * became an array — see services/activeSelection.service.ts. Mongoose reads in
 * strict mode, so without this migration every existing user's active path
 * simply stops being seen: their courses lock, their resume hero empties, and
 * the path they committed to looks like it was never started.
 *
 * `activePathId` is left in place rather than unset. It costs nothing, and it
 * is the only way back if this needs to be re-run or reversed.
 *
 * DRY RUN BY DEFAULT — prints what would change and writes nothing.
 *   npm run migrate:active-paths             # preview
 *   npm run migrate:active-paths -- --apply  # write
 *
 * Safe to run twice: a user who already has a non-empty `activePathIds` is
 * skipped, so a second run finds nothing to do.
 *
 * Lives under src/ rather than scripts/ on purpose: this is a MANDATORY
 * production migration, and everything under scripts/ needs `tsx` — a
 * devDependency that `npm ci --omit=dev` does not install. It compiles into
 * dist/ with the rest of the server, so a production host can actually run it.
 */
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { UserModel } from "../database/models/user.model.js";

const APPLY = process.argv.includes("--apply");

type Row = { _id: unknown; email?: string; activePathId?: unknown; activePathIds?: unknown[] };

await mongoose.connect(env.MONGODB_URI);

// Read through the driver, not the schema: `activePathId` is no longer in the
// User schema, so a Mongoose projection would drop the very field being read.
const users = (await UserModel.collection
  .find(
    { activePathId: { $ne: null, $exists: true } },
    { projection: { email: 1, activePathId: 1, activePathIds: 1 } },
  )
  .toArray()) as unknown as Row[];

const pending = users.filter((u) => !u.activePathIds || u.activePathIds.length === 0);

console.log(
  `Users with a legacy activePathId: ${users.length}, of which ${pending.length} still need migrating`,
);
for (const u of pending) {
  console.log(`  ${String(u.email ?? u._id)} → [${String(u.activePathId)}]`);
}

if (APPLY && pending.length) {
  // Written through the driver, like the read above: `activePathId` is no longer
  // in the User schema, so Mongoose's typed bulkWrite cannot describe this
  // update — and casting around its types would only hide that.
  await UserModel.collection.bulkWrite(
    pending.map((u) => ({
      updateOne: {
        filter: { _id: u._id as never },
        update: { $set: { activePathIds: [u.activePathId] } },
      },
    })),
  );
  console.log(`\nDone — ${pending.length} user(s) migrated.`);
} else if (!APPLY) {
  console.log(`\nDry run — nothing written. Re-run with --apply to write.`);
}

await mongoose.disconnect();
