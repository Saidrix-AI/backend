/**
 * One-off: fold the removed "bn-latn" (Banglish) content language into "bn".
 *
 * Banglish was offered on the intake's language card beside Bangla, which is
 * one language wearing two hats — see validation/language.ts. Dropping it from
 * the code leaves stored documents pointing at a language nothing can render a
 * rule for, so every field that carried it is rewritten here.
 *
 * Idempotent: re-running finds nothing and reports zeroes.
 *
 *   npm run migrate:drop-banglish
 */
import { connectDatabase, disconnectDatabase } from "../src/database/connect.js";
import { CourseModel } from "../src/database/models/course.model.js";
import { KnowledgeAssessmentModel } from "../src/database/models/knowledgeAssessment.model.js";
import { LearningIntakeModel } from "../src/database/models/learningIntake.model.js";
import { LectureModel } from "../src/database/models/lecture.model.js";
import { UserModel } from "../src/database/models/user.model.js";

const OLD = "bn-latn";
const NEW = "bn";

/* eslint-disable no-console */

await connectDatabase();

const courses = await CourseModel.updateMany({ language: OLD }, { $set: { language: NEW } });
console.log(`courses.language: ${courses.modifiedCount} updated`);

const lectures = await LectureModel.updateMany({ language: OLD }, { $set: { language: NEW } });
console.log(`lectures.language: ${lectures.modifiedCount} updated`);

const intakes = await LearningIntakeModel.updateMany({ language: OLD }, { $set: { language: NEW } });
console.log(`learningintakes.language: ${intakes.modifiedCount} updated`);

const checks = await KnowledgeAssessmentModel.updateMany(
  { language: OLD },
  { $set: { language: NEW } },
);
console.log(`knowledgeassessments.language: ${checks.modifiedCount} updated`);

const legacy = await UserModel.updateMany(
  { preferredLanguage: OLD },
  { $set: { preferredLanguage: NEW } },
);
console.log(`users.preferredLanguage: ${legacy.modifiedCount} updated`);

// ORDER MATTERS on the array field. Add Bangla to everyone who listed Banglish
// FIRST, then remove Banglish — the reverse order throws away the fact that
// they read Bangla at all. $addToSet is what makes it safe for a user who
// already listed both: it will not write a duplicate.
const promoted = await UserModel.updateMany(
  { preferredLanguages: OLD },
  { $addToSet: { preferredLanguages: NEW } },
);
const cleaned = await UserModel.updateMany(
  { preferredLanguages: OLD },
  { $pull: { preferredLanguages: OLD } },
);
console.log(
  `users.preferredLanguages: ${promoted.modifiedCount} gained Bangla, ` +
    `${cleaned.modifiedCount} had Banglish removed`,
);

await disconnectDatabase();
