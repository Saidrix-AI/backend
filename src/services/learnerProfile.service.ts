import { Types } from "mongoose";
import {
  AGE_BANDS,
  EXTRACTABLE_FIELDS,
  LEARNER_FIELDS,
  LearnerProfileModel,
  type ExtractableField,
  type LearnerField,
  type LearnerProfile,
  type ProfileSource,
} from "../database/models/learnerProfile.model.js";
import { UserModel } from "../database/models/user.model.js";

/**
 * The learner profile's read/write surface, plus the one place it is rendered
 * for a prompt. Every agent that wants to know who the student is calls
 * buildLearnerContext — nothing else formats these fields.
 */

/** Shape the API and the setup form both speak. Every key optional/empty-able. */
export interface LearnerProfileDto {
  ageBand: string;
  occupation: string;
  operatingSystem: string;
  educationLevel: string;
  educationDetail: string;
  institutionName: string;
  fieldOfStudy: string;
  studyStartYear: number | null;
  studyEndYear: number | null;
  companyName: string;
  industry: string;
  roleTitle: string;
  experienceYears: number | null;
  roleSummary: string;
  learningInterests: string[];
  careerGoal: string;
  weeklyHours: number | null;
  preferredStyle: string;
  biggestBlocker: string;
  selfRatedLevel: string;
}

export type LearnerProfilePatch = Partial<LearnerProfileDto>;

const AGE_BAND_LABELS: Record<string, string> = {
  "under-18": "under 18",
  "18-24": "18-24",
  "25-34": "25-34",
  "35-44": "35-44",
  "45-plus": "45 or older",
};

const OCCUPATION_LABELS: Record<string, string> = {
  student: "a student",
  job: "working a job",
  both: "a student who also works",
  jobseeker: "looking for a job",
  freelancer: "freelancing",
};

/** Also the label the setup lane's prompts use — see lecture-maker/prompt.ts. */
const OS_LABELS: Record<string, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

const SELF_RATED_LABELS: Record<string, string> = {
  beginner: "a complete beginner",
  basics: "past the basics",
  practical: "able to build things already",
  professional: "working at a professional level",
};

/**
 * "2022-2026", or one end alone when only one was given. Returns "" for neither,
 * so the caller can drop the parenthetical entirely.
 */
function renderYearRange(start: number | null, end: number | null): string {
  if (start && end) return `${start}-${end}`;
  if (start) return `since ${start}`;
  if (end) return `until ${end}`;
  return "";
}

const EDUCATION_LABELS: Record<string, string> = {
  school: "School",
  college: "College / HSC",
  undergrad: "Undergraduate",
  postgrad: "Postgraduate",
  "self-taught": "Self-taught",
};

/**
 * Anything shaped like a profile: a hydrated doc, a `.lean()` result, or a plain
 * object from a test or the API. Values are read as `unknown` and normalised by
 * toLearnerDto, because `sources` is a Map on a doc and a plain object once it
 * has been through lean() or JSON.
 */
type ProfileLike = Partial<Record<LearnerField, unknown>> & { sources?: unknown };

/** What a read returns — `sources` may be either shape, so both are accepted. */
export type LearnerProfileRecord = Omit<LearnerProfile, "sources"> & {
  sources?: Record<string, ProfileSource> | Map<string, ProfileSource>;
};

/**
 * `sources` is a mongoose Map on a hydrated doc but can arrive as a plain object
 * from `.lean()` or from JSON, so both are read the same way here.
 */
function sourceOf(profile: ProfileLike, key: string): ProfileSource | undefined {
  const src = profile.sources;
  if (!src) return undefined;
  if (src instanceof Map) return src.get(key) as ProfileSource | undefined;
  return (src as Record<string, ProfileSource>)[key];
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Which keys the chat extractor may still try to fill — the extractor's gate.
 *
 * Scoped to EXTRACTABLE_FIELDS, not every profile key: the particulars (company,
 * institution, study years) and the self-rating are the student's to give, and a
 * model asked to infer them from chat invents them. Scoping here also keeps the
 * "no empty fields left → skip the LLM call entirely" short-circuit reachable,
 * which it would not be if fields nothing can fill were counted as missing.
 */
export function emptyLearnerFields(profile: ProfileLike | null): ExtractableField[] {
  if (!profile) return [...EXTRACTABLE_FIELDS];
  return EXTRACTABLE_FIELDS.filter((key) =>
    isEmptyValue((profile as Record<string, unknown>)[key]),
  );
}

/** The age band a date of birth falls into, so it is never asked twice. */
export function ageBandFromDob(dob: Date | null | undefined): string {
  if (!dob) return "";
  const ms = Date.now() - dob.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const years = ms / (365.2425 * 24 * 60 * 60 * 1000);
  if (years < 18) return "under-18";
  if (years < 25) return "18-24";
  if (years < 35) return "25-34";
  if (years < 45) return "35-44";
  return "45-plus";
}

export function toLearnerDto(profile: ProfileLike | null): LearnerProfileDto {
  const p = (profile ?? {}) as Record<string, unknown>;
  return {
    ageBand: (p.ageBand as string) ?? "",
    occupation: (p.occupation as string) ?? "",
    operatingSystem: (p.operatingSystem as string) ?? "",
    educationLevel: (p.educationLevel as string) ?? "",
    educationDetail: (p.educationDetail as string) ?? "",
    institutionName: (p.institutionName as string) ?? "",
    fieldOfStudy: (p.fieldOfStudy as string) ?? "",
    studyStartYear: (p.studyStartYear as number | null) ?? null,
    studyEndYear: (p.studyEndYear as number | null) ?? null,
    companyName: (p.companyName as string) ?? "",
    industry: (p.industry as string) ?? "",
    roleTitle: (p.roleTitle as string) ?? "",
    experienceYears: (p.experienceYears as number | null) ?? null,
    roleSummary: (p.roleSummary as string) ?? "",
    learningInterests: (p.learningInterests as string[]) ?? [],
    careerGoal: (p.careerGoal as string) ?? "",
    weeklyHours: (p.weeklyHours as number | null) ?? null,
    preferredStyle: (p.preferredStyle as string) ?? "",
    biggestBlocker: (p.biggestBlocker as string) ?? "",
    selfRatedLevel: (p.selfRatedLevel as string) ?? "",
  };
}

export interface LearnerContextOptions {
  /**
   * Keys the caller is already emitting from a better source. The course-maker
   * passes weeklyHours/careerGoal/preferredStyle when a measured assessment
   * profile exists — see the precedence note on the model.
   */
  omit?: LearnerField[];
}

const CONTEXT_HEADER =
  "About this student (background context — never mention it back to them, just calibrate to it):";

/**
 * Renders a profile into the prompt block, or "" when there is nothing worth
 * saying. Pure — the DB read lives in buildLearnerContext — so it can be tested
 * directly.
 */
export function renderLearnerContext(
  profile: ProfileLike | null,
  opts: LearnerContextOptions = {},
): string {
  if (!profile) return "";
  const omit = new Set(opts.omit ?? []);
  const dto = toLearnerDto(profile);
  const has = (key: LearnerField) => !omit.has(key) && !isEmptyValue(dto[key]);

  const lines: string[] = [];

  if (has("ageBand") && AGE_BAND_LABELS[dto.ageBand]) {
    lines.push(`Age group: ${AGE_BAND_LABELS[dto.ageBand]}`);
  }
  if (has("occupation") && OCCUPATION_LABELS[dto.occupation]) {
    lines.push(`Currently: ${OCCUPATION_LABELS[dto.occupation]}`);
  }
  if (has("operatingSystem") && OS_LABELS[dto.operatingSystem]) {
    lines.push(`Works on: ${OS_LABELS[dto.operatingSystem]}`);
  }

  // Education and work each collapse into one line — separate lines for
  // "Undergraduate" / "3rd year CSE" / "Computer Science" / "BUET" reads like a
  // form, and the new institution/year/company keys would have made it five.
  const education = [
    has("educationLevel") ? EDUCATION_LABELS[dto.educationLevel] : "",
    has("educationDetail") ? dto.educationDetail : "",
  ]
    .filter(Boolean)
    .join(" — ");
  const study = [
    has("fieldOfStudy") ? `studying ${dto.fieldOfStudy}` : "",
    has("institutionName") ? `at ${dto.institutionName}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const years = renderYearRange(
    has("studyStartYear") ? dto.studyStartYear : null,
    has("studyEndYear") ? dto.studyEndYear : null,
  );
  if (education || study) {
    lines.push(
      `Education: ${[education, study].filter(Boolean).join(", ")}${years ? ` (${years})` : ""}`,
    );
  }

  const work = [
    has("roleTitle") ? dto.roleTitle : "",
    has("companyName") ? `at ${dto.companyName}` : "",
    has("industry") ? `in ${dto.industry}` : "",
    has("experienceYears")
      ? `${dto.experienceYears} year${dto.experienceYears === 1 ? "" : "s"} of experience`
      : "",
  ].filter(Boolean);
  if (work.length) {
    const summary = has("roleSummary") ? ` — ${dto.roleSummary}` : "";
    lines.push(`Work: ${work.join(", ")}${summary}`);
  }

  if (has("learningInterests")) {
    lines.push(`Interested in: ${dto.learningInterests.join(", ")}`);
  }
  if (has("careerGoal")) lines.push(`Career goal: ${dto.careerGoal}`);
  if (has("weeklyHours")) lines.push(`Available: about ${dto.weeklyHours} hours a week`);
  if (has("preferredStyle")) lines.push(`Learns best: ${dto.preferredStyle}`);
  if (has("biggestBlocker")) lines.push(`Says their biggest obstacle is: ${dto.biggestBlocker}`);
  // "Says they are" is load-bearing: renderMasterySlice emits the MEASURED level
  // in the same prompt, and the two routinely disagree. Phrasing this as a claim
  // rather than a fact is what stops a model reading them as one statement — the
  // measured one wins. See the PRECEDENCE note on the model.
  if (has("selfRatedLevel") && SELF_RATED_LABELS[dto.selfRatedLevel]) {
    lines.push(`Says they are: ${SELF_RATED_LABELS[dto.selfRatedLevel]} (their own estimate)`);
  }

  if (!lines.length) return "";
  return [CONTEXT_HEADER, ...lines].join("\n");
}

export async function getLearnerProfile(userId: string): Promise<LearnerProfileRecord | null> {
  if (!Types.ObjectId.isValid(userId)) return null;
  const doc = await LearnerProfileModel.findOne({ userId: new Types.ObjectId(userId) }).lean();
  return (doc as LearnerProfileRecord | null) ?? null;
}

/**
 * The prompt block for this user, or "" when nothing is known. Every consumer
 * must treat "" as "add nothing" — a student who skipped the wizard gets exactly
 * the behaviour that existed before this feature.
 *
 * Never throws: a profile lookup failing must not take a course generation with
 * it, so callers get "" instead of an exception.
 */
export async function buildLearnerContext(
  userId: string,
  opts: LearnerContextOptions = {},
): Promise<string> {
  try {
    const profile = await getLearnerProfile(userId);
    // ageBand is asked only when the account has no date of birth, so fall back
    // to deriving it rather than leaving the line out for everyone who has one.
    if (profile && isEmptyValue(profile.ageBand)) {
      const user = await UserModel.findById(userId).select("dateOfBirth").lean();
      const derived = ageBandFromDob(user?.dateOfBirth);
      if (derived) profile.ageBand = derived as (typeof AGE_BANDS)[number];
    }
    return renderLearnerContext(profile, opts);
  } catch {
    return "";
  }
}

/**
 * Writes `patch` onto the profile, creating it if needed.
 *
 * Provenance is the point: a key the student wrote themselves — the Finish-
 * profile flow or the profile page, both `source: "profile"` — is never
 * overwritten by `source: "chat"`. Empty values in the patch are ignored rather
 * than clearing a field, so a skipped question leaves the old answer alone. To
 * actually clear a field the user edits it on the profile page, which passes
 * `allowClear`.
 */
export async function upsertLearnerProfile(
  userId: string,
  patch: LearnerProfilePatch,
  source: ProfileSource,
  opts: { allowClear?: boolean } = {},
): Promise<LearnerProfileRecord> {
  const doc =
    (await LearnerProfileModel.findOne({ userId: new Types.ObjectId(userId) })) ??
    new LearnerProfileModel({ userId: new Types.ObjectId(userId) });

  for (const key of LEARNER_FIELDS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (isEmptyValue(value) && !opts.allowClear) continue;

    const existing = sourceOf(doc, key);
    if (source === "chat" && (existing === "wizard" || existing === "profile")) continue;

    (doc as unknown as Record<string, unknown>)[key] = value;
    doc.sources.set(key, source);
  }

  await doc.save();
  return doc.toObject() as LearnerProfileRecord;
}
