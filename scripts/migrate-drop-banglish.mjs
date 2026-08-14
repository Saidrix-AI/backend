/**
 * One-off: fold the removed "bn-latn" (Banglish) content language into "bn".
 *
 * Banglish was offered on the intake's language card beside Bangla, which is
 * one language wearing two hats — see validation/language.ts. Dropping it from
 * the code leaves stored documents pointing at a language nothing can render a
 * rule for, so every field that carried it is rewritten here.
 *
 * Left unrun, a stale "bn-latn" in `users.preferredLanguages` breaks LOGIN:
 * auth.service.ts calls `user.save()` to clear failedLoginAttempts, mongoose
 * validates the WHOLE document, and the value no longer passes the enum in
 * user.model.ts — so the request 500s. Only users with a prior failed attempt
 * hit it, which is why it looks intermittent.
 *
 * ---------------------------------------------------------------------------
 * Plain .mjs, not TypeScript, and deliberately so.
 * ---------------------------------------------------------------------------
 * The production image has no `tsx`: nixpacks runs `npm prune --omit=dev` after
 * building (see DEPLOY-NIXPACKS.md), and `tsconfig.build.json` only compiles
 * `src/**`, so nothing under `scripts/` reaches `dist/` either. The original
 * `scripts/migrate-drop-banglish.ts` therefore cannot run on the server at all.
 * This talks to the raw collections and needs only `mongoose`, a production
 * dependency — same approach as backfill-ever-paid.mjs.
 *
 * Idempotent: re-running finds nothing and reports zeroes.
 *
 *   npm run migrate:drop-banglish
 *
 * Against a database other than the one in .env:
 *
 *   MONGODB_URI="mongodb+srv://…" npm run migrate:drop-banglish
 */
import "dotenv/config";
import mongoose from "mongoose";

const OLD = "bn-latn";
const NEW = "bn";

/* eslint-disable no-console */

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set. Pass it explicitly:");
  console.error('  MONGODB_URI="mongodb+srv://…" npm run migrate:drop-banglish');
  process.exit(1);
}

// Host only — the URI carries credentials and must not be printed.
console.log(`Connecting to ${uri.replace(/\/\/[^@]*@/, "//<credentials>@")}`);
await mongoose.connect(uri);

const db = mongoose.connection;

// Scalar `language` fields: a straight rewrite.
for (const name of ["courses", "lectures", "learningintakes", "knowledgeassessments"]) {
  const res = await db.collection(name).updateMany({ language: OLD }, { $set: { language: NEW } });
  console.log(`${name}.language: ${res.modifiedCount} updated`);
}

const users = db.collection("users");

const legacy = await users.updateMany(
  { preferredLanguage: OLD },
  { $set: { preferredLanguage: NEW } },
);
console.log(`users.preferredLanguage: ${legacy.modifiedCount} updated`);

// ORDER MATTERS on the array field. Add Bangla to everyone who listed Banglish
// FIRST, then remove Banglish — the reverse order throws away the fact that
// they read Bangla at all. $addToSet is what makes it safe for a user who
// already listed both: it will not write a duplicate.
const promoted = await users.updateMany(
  { preferredLanguages: OLD },
  { $addToSet: { preferredLanguages: NEW } },
);
const cleaned = await users.updateMany(
  { preferredLanguages: OLD },
  { $pull: { preferredLanguages: OLD } },
);
console.log(
  `users.preferredLanguages: ${promoted.modifiedCount} gained Bangla, ` +
    `${cleaned.modifiedCount} had Banglish removed`,
);

const left = await users.countDocuments({
  $or: [{ preferredLanguages: OLD }, { preferredLanguage: OLD }],
});
console.log(
  left === 0
    ? "No Banglish left on any user. Safe to re-run."
    : `WARNING: ${left} user(s) still carry "${OLD}".`,
);

await mongoose.disconnect();
