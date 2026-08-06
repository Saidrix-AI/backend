import { Schema, model, Types, type InferSchemaType } from "mongoose";

/**
 * Who the student actually is — the one canonical per-user profile document.
 *
 * Before this existed the only picture of a learner was the newest completed
 * KnowledgeAssessment, which is measured per topic and resolved by recency. That
 * answers "how much do they know about Python", never "are they a 30-year-old
 * backend engineer or a class-9 student". Both facts change how a course should
 * be written, so they are kept apart:
 *
 *   KnowledgeAssessment.profile  — measured, per topic, short-lived
 *   LearnerProfile (this)        — self-reported, stable, one per user
 *
 * PRECEDENCE. `weeklyHours`, `careerGoal` and `preferredStyle` overlap with
 * KnowledgeAssessment.profile's `weeklyHours`, `goal` and `styleNotes`. The
 * assessment's versions are measured against a specific topic and WIN for the
 * course being generated; the values here are the stable baseline, used when no
 * assessment exists yet. services/learnerProfile.service.ts takes an `omit` list
 * for exactly this reason — see buildLearnerContext.
 *
 * Everything is optional. A half-filled profile is the normal case — nothing
 * asks the student to fill it in directly; the passive chat extractor fills
 * gaps over time as they come up in conversation.
 */

export const AGE_BANDS = ["under-18", "18-24", "25-34", "35-44", "45-plus"] as const;
export const OCCUPATIONS = [
  "student",
  "job",
  "both",
  "jobseeker",
  "freelancer",
  "other",
] as const;
/**
 * Which machine they will actually be working on. Asked in the guided intake,
 * before any course is generated, because the lecture-maker's setup lane writes
 * install steps for ONE operating system — a guide hedged across all three is
 * two thirds noise for whoever is reading it.
 */
export const OPERATING_SYSTEMS = ["windows", "macos", "linux"] as const;
export const EDUCATION_LEVELS = [
  "school",
  "college",
  "undergrad",
  "postgrad",
  "self-taught",
  "other",
] as const;

/**
 * Where each filled field came from. The passive chat extractor only ever writes
 * into keys that are empty or already `chat` — a value the student typed
 * themselves is never overwritten by an inference.
 *
 * `wizard` is historical: the post-signup wizard that wrote it is gone, but
 * profiles filled while it existed still carry the value, and dropping it from
 * the enum would fail validation the next time one of those documents is saved.
 */
export const PROFILE_SOURCES = ["wizard", "profile", "chat"] as const;
export type ProfileSource = (typeof PROFILE_SOURCES)[number];

/**
 * How the student rates themselves — deliberately NOT the same thing as the
 * level KnowledgeAssessment measures. Both can be present and disagree; the
 * measured one wins, and this is rendered as "says they are" so a prompt can
 * never read the two as one claim. See the PRECEDENCE note above.
 */
export const SELF_RATED_LEVELS = ["beginner", "basics", "practical", "professional"] as const;

/**
 * Study-year bounds. The upper end runs ahead of today because `studyEndYear` is
 * routinely an *expected* graduation year, and a first-year undergraduate's
 * answer is four or five years out.
 */
export const YEAR_MIN = 1950;
export const YEAR_MAX = new Date().getFullYear() + 10;

/** Every answer key, in the order buildLearnerContext renders them. */
export const LEARNER_FIELDS = [
  "ageBand",
  "occupation",
  "operatingSystem",
  "educationLevel",
  "educationDetail",
  "institutionName",
  "fieldOfStudy",
  "studyStartYear",
  "studyEndYear",
  "companyName",
  "industry",
  "roleTitle",
  "experienceYears",
  "roleSummary",
  "learningInterests",
  "careerGoal",
  "weeklyHours",
  "preferredStyle",
  "biggestBlocker",
  "selfRatedLevel",
] as const;
export type LearnerField = (typeof LEARNER_FIELDS)[number];

/**
 * The subset the passive chat extractor may infer — NOT the same as LEARNER_FIELDS.
 *
 * The excluded keys are concrete particulars (which company, which university,
 * which years) or a self-assessment. A model asked to fill those from loose chat
 * invents plausible answers, and because they are written as `source: "chat"`
 * they would then sit on the profile looking like something the student said.
 * They are only ever set by the student's own hand — the Finish-profile form or
 * the profile page.
 *
 * Keep this list narrow. Widening it is a product decision, not a cleanup.
 */
export const EXTRACTABLE_FIELDS = [
  "ageBand",
  "occupation",
  // "I'm on Windows 11" in chat is a fact about them, not a particular they
  // would be surprised to see remembered — and getting it wrong costs nothing
  // worse than an install guide for the wrong OS, which they will say so about.
  "operatingSystem",
  "educationLevel",
  "educationDetail",
  "fieldOfStudy",
  "industry",
  "roleTitle",
  "experienceYears",
  "learningInterests",
  "careerGoal",
  "weeklyHours",
  "preferredStyle",
  "biggestBlocker",
] as const satisfies readonly LearnerField[];
export type ExtractableField = (typeof EXTRACTABLE_FIELDS)[number];

/**
 * "" means not answered yet. It is added to the schema enums but deliberately
 * kept out of the exported constants above, which the wizard turns into option
 * lists — an "unanswered" option would be nonsense on a card.
 */
const UNANSWERED = "";

const learnerProfileSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, unique: true, index: true },

    // --- Who they are ---
    /** Asked only when User.dateOfBirth is empty — otherwise derived from it. */
    ageBand: { type: String, enum: [...AGE_BANDS, UNANSWERED], default: UNANSWERED },
    occupation: { type: String, enum: [...OCCUPATIONS, UNANSWERED], default: UNANSWERED },
    /** Asked in the guided intake; drives the setup lane's install steps. */
    operatingSystem: { type: String, enum: [...OPERATING_SYSTEMS, UNANSWERED], default: UNANSWERED },
    educationLevel: {
      type: String,
      enum: [...EDUCATION_LEVELS, UNANSWERED],
      default: UNANSWERED,
    },
    /** "Class 9", "HSC 2nd year", "3rd year CSE" — too varied to enumerate. */
    educationDetail: { type: String, trim: true, default: "", maxlength: 80 },
    institutionName: { type: String, trim: true, default: "", maxlength: 120 },
    fieldOfStudy: { type: String, trim: true, default: "", maxlength: 80 },
    /** Bounds match the route's zod schema; see YEAR_MIN there. */
    studyStartYear: { type: Number, min: YEAR_MIN, max: YEAR_MAX, default: null },
    /** Expected end year is fine — students give the year they hope to finish. */
    studyEndYear: { type: Number, min: YEAR_MIN, max: YEAR_MAX, default: null },

    // --- Working life ---
    companyName: { type: String, trim: true, default: "", maxlength: 120 },
    industry: { type: String, trim: true, default: "", maxlength: 80 },
    roleTitle: { type: String, trim: true, default: "", maxlength: 80 },
    experienceYears: { type: Number, min: 0, max: 60, default: null },
    /** What the role actually involves, in their words. */
    roleSummary: { type: String, trim: true, default: "", maxlength: 300 },

    // --- What they want out of Saidrix ---
    learningInterests: { type: [String], default: [] },
    careerGoal: { type: String, trim: true, default: "", maxlength: 200 },
    weeklyHours: { type: Number, min: 0, max: 80, default: null },
    preferredStyle: { type: String, trim: true, default: "", maxlength: 200 },
    /** What is getting in their way — the single most actionable line for a tutor. */
    biggestBlocker: { type: String, trim: true, default: "", maxlength: 200 },
    selfRatedLevel: {
      type: String,
      enum: [...SELF_RATED_LEVELS, UNANSWERED],
      default: UNANSWERED,
    },

    /** field name → who wrote it. Guards the extractor against clobbering answers. */
    sources: {
      type: Map,
      of: { type: String, enum: [...PROFILE_SOURCES] },
      default: () => new Map<string, ProfileSource>(),
    },
  },
  { timestamps: true },
);

export type LearnerProfile = InferSchemaType<typeof learnerProfileSchema>;
export const LearnerProfileModel = model("LearnerProfile", learnerProfileSchema);
