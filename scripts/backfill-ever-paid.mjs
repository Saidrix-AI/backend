/**
 * One-off: mark every pre-existing subscription as having actually paid.
 *
 * `Subscription.everPaid` was added with the 1-day Basic trial. It decides
 * whether a `past_due` account keeps its ~2-week retry grace (a customer whose
 * card failed) or is locked out immediately (a trial whose very first charge
 * never went through) — see services/subscription.service.ts#accessFor.
 *
 * New documents default it to `false`, which is right for a fresh trial and
 * WRONG for every row written before this feature existed: trials did not
 * exist, so every one of those subscriptions began with a real payment. Without
 * this backfill the next established customer whose card failed would be
 * treated as a failed trial and locked out of an account they have been paying
 * for.
 *
 * Must run BEFORE the new build starts serving traffic.
 *
 * ---------------------------------------------------------------------------
 * Plain .mjs, not TypeScript, and deliberately so.
 * ---------------------------------------------------------------------------
 * The production image has no `tsx`: nixpacks runs `npm prune --omit=dev` after
 * building, which strips the whole dev tree (see DEPLOY-NIXPACKS.md). And
 * `tsconfig.build.json` only compiles `src/**`, so nothing under `scripts/`
 * ever reaches `dist/` either. A `tsx scripts/*.ts` migration therefore cannot
 * be run on the server at all.
 *
 * This needs only `mongoose`, which IS a production dependency, so it runs with
 * plain `node` on the server, on a laptop, anywhere.
 *
 * Idempotent: re-running matches nothing and reports zero.
 *
 *   npm run migrate:ever-paid
 *
 * Against a database other than the one in .env:
 *
 *   MONGODB_URI="mongodb+srv://…" npm run migrate:ever-paid
 */
import "dotenv/config";
import mongoose from "mongoose";

/* eslint-disable no-console */

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set. Pass it explicitly:");
  console.error('  MONGODB_URI="mongodb+srv://…" npm run migrate:ever-paid');
  process.exit(1);
}

// Host only — the URI carries credentials and must not be printed.
console.log(`Connecting to ${uri.replace(/\/\/[^@]*@/, "//<credentials>@")}`);
await mongoose.connect(uri);

const subscriptions = mongoose.connection.collection("subscriptions");

const total = await subscriptions.countDocuments({});
// `$ne: true` rather than `false`, so rows written before the field existed —
// which carry no `everPaid` key at all — are matched too.
const pending = await subscriptions.countDocuments({ everPaid: { $ne: true } });

const result = await subscriptions.updateMany(
  { everPaid: { $ne: true } },
  { $set: { everPaid: true } },
);

console.log(`subscriptions: ${total} total, ${pending} needed it, ${result.modifiedCount} updated`);
if (result.modifiedCount === 0 && pending === 0) {
  console.log("Nothing to do — every subscription is already marked. Safe to re-run.");
}

await mongoose.disconnect();
