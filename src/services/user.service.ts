import { UserModel } from "../database/models/user.model.js";
import { LEARNER_FIELDS } from "../database/models/learnerProfile.model.js";
import type { PlanId } from "../config/plans.js";
import { ApiError } from "../utils/apiError.js";
import {
  getLearnerProfile,
  toLearnerDto,
  upsertLearnerProfile,
  type LearnerProfileDto,
  type LearnerProfilePatch,
} from "./learnerProfile.service.js";

export interface UserProfile {
  id: string;
  name: string;
  username: string;
  email: string;
  role: string;
  emailVerified: boolean;
  phone: string;
  dateOfBirth: string | null;
  country: string;
  address: string;
  timezone: string;
  language: string;
  /** Recorded preference only — nothing applies it. See the User model note. */
  preferredLanguages: string[];
  referralSource: string;
  bio: string;
  avatar: string;
  wishlistCourseIds: string[];
  memberSince: string;
  /** Drives the dashboard's Finish-profile popup and banner. */
  profileSetup: ProfileSetupState;
  /** null until the user picks a plan — there is no free tier to fall back to. */
  plan: PlanId | null;
  planSince: string | null;
  /**
   * Who they are as a learner, from the separate LearnerProfile collection.
   * Always present — an untouched profile is all empties, never null, so the
   * client can render the card without null-checking every field.
   */
  learner: LearnerProfileDto;
}

// Fields a user may edit. email / username / role are intentionally excluded.
export interface ProfileUpdate extends LearnerProfilePatch {
  name?: string;
  phone?: string;
  dateOfBirth?: string | null;
  country?: string;
  address?: string;
  timezone?: string;
  language?: string;
  preferredLanguages?: string[];
  referralSource?: string;
  bio?: string;
}

/** Where the student is in the Finish-profile flow. */
export interface ProfileSetupState {
  /** 0 = the step-1 form, 1 = the step-2 questions. */
  step: number;
  completedAt: string | null;
  skippedAt: string | null;
  /**
   * Both timestamps null. Accounts created before this feature have no
   * sub-document at all, which lands here as `true` — they are offered the
   * popup once on their next login, which is the intended behaviour.
   */
  pending: boolean;
}

type UserDoc = {
  _id: unknown;
  name: string;
  username: string;
  email: string;
  role: string;
  emailVerified: boolean;
  phone: string;
  dateOfBirth?: Date | null;
  country: string;
  address?: string;
  timezone: string;
  language: string;
  preferredLanguages?: string[];
  /** Pre-2026-08-03 single value; read only as a fallback. */
  preferredLanguage?: string;
  referralSource?: string;
  bio: string;
  avatar: string;
  wishlistCourseIds: string[];
  createdAt: Date;
  plan?: PlanId | null;
  planSince?: Date | null;
  profileSetup?: { step?: number; completedAt?: Date | null; skippedAt?: Date | null } | null;
};

function toSetupState(setup: UserDoc["profileSetup"]): ProfileSetupState {
  const completedAt = setup?.completedAt ?? null;
  const skippedAt = setup?.skippedAt ?? null;
  return {
    step: setup?.step ?? 0,
    completedAt: completedAt ? completedAt.toISOString() : null,
    skippedAt: skippedAt ? skippedAt.toISOString() : null,
    pending: !completedAt && !skippedAt,
  };
}

function toProfile(u: UserDoc, learner: LearnerProfileDto): UserProfile {
  return {
    learner,
    id: String(u._id),
    name: u.name,
    username: u.username,
    email: u.email,
    role: u.role,
    emailVerified: u.emailVerified,
    phone: u.phone ?? "",
    dateOfBirth: u.dateOfBirth ? u.dateOfBirth.toISOString() : null,
    country: u.country ?? "",
    address: u.address ?? "",
    timezone: u.timezone ?? "",
    language: u.language ?? "",
    // Falls back to the superseded single value so a profile filled in before
    // the picker became multi-select still shows its answer.
    preferredLanguages: u.preferredLanguages?.length
      ? u.preferredLanguages
      : u.preferredLanguage
        ? [u.preferredLanguage]
        : [],
    referralSource: u.referralSource ?? "",
    bio: u.bio ?? "",
    avatar: u.avatar ?? "",
    wishlistCourseIds: u.wishlistCourseIds ?? [],
    memberSince: u.createdAt.toISOString(),
    plan: u.plan ?? null,
    planSince: u.planSince ? u.planSince.toISOString() : null,
    profileSetup: toSetupState(u.profileSetup),
  };
}

/** The user document plus its learner profile, which lives in its own collection. */
async function assemble(user: unknown, userId: string): Promise<UserProfile> {
  if (!user) throw new ApiError(404, "User not found");
  const learner = await getLearnerProfile(userId);
  return toProfile(user as UserDoc, toLearnerDto(learner));
}

export async function getProfile(userId: string): Promise<UserProfile> {
  return assemble(await UserModel.findById(userId), userId);
}

export async function updateProfile(
  userId: string,
  input: ProfileUpdate,
): Promise<UserProfile> {
  const update: Record<string, unknown> = {};
  if (input.name !== undefined) update.name = input.name;
  if (input.phone !== undefined) update.phone = input.phone;
  if (input.country !== undefined) update.country = input.country;
  if (input.address !== undefined) update.address = input.address;
  if (input.timezone !== undefined) update.timezone = input.timezone;
  if (input.language !== undefined) update.language = input.language;
  if (input.preferredLanguages !== undefined) {
    update.preferredLanguages = input.preferredLanguages;
    // Clear the superseded field, or the fallback above would resurrect an old
    // answer the moment someone deselects everything.
    update.preferredLanguage = "";
  }
  if (input.referralSource !== undefined) update.referralSource = input.referralSource;
  if (input.bio !== undefined) update.bio = input.bio;
  if (input.dateOfBirth !== undefined) {
    update.dateOfBirth = input.dateOfBirth ? new Date(input.dateOfBirth) : null;
  }

  // The learner keys live in another collection, so they are split off and
  // written separately. allowClear is on: an empty value from this form is the
  // student erasing an answer, not declining to give one.
  const learnerPatch: LearnerProfilePatch = {};
  for (const key of LEARNER_FIELDS) {
    if (input[key] !== undefined) (learnerPatch as Record<string, unknown>)[key] = input[key];
  }
  if (Object.keys(learnerPatch).length) {
    await upsertLearnerProfile(userId, learnerPatch, "profile", { allowClear: true });
  }

  const user = await UserModel.findByIdAndUpdate(userId, update, { new: true });
  return assemble(user, userId);
}

export async function updateAvatar(userId: string, avatar: string): Promise<UserProfile> {
  return assemble(
    await UserModel.findByIdAndUpdate(userId, { avatar }, { new: true }),
    userId,
  );
}

/**
 * Moves the Finish-profile flow along. Only the flow's own state lives here —
 * the answers themselves go through updateProfile, so there is one write path
 * for profile data and provenance stays consistent.
 *
 * `completed` and `skipped` are both terminal for the auto-popup; they differ in
 * whether the dashboard keeps offering the banner. Finishing after a skip is
 * normal (the banner is how they come back), so completing clears `skippedAt`.
 */
export async function updateProfileSetup(
  userId: string,
  input: { step?: number; status?: "completed" | "skipped" },
): Promise<UserProfile> {
  const update: Record<string, unknown> = {};
  if (input.step !== undefined) update["profileSetup.step"] = input.step;
  if (input.status === "completed") {
    update["profileSetup.completedAt"] = new Date();
    update["profileSetup.skippedAt"] = null;
  }
  if (input.status === "skipped") update["profileSetup.skippedAt"] = new Date();

  const user = Object.keys(update).length
    ? await UserModel.findByIdAndUpdate(userId, update, { new: true })
    : await UserModel.findById(userId);
  return assemble(user, userId);
}

// `setPlan` used to live here, called from `PUT /api/user/plan`. It was removed
// with that route: a plan is now written only by
// services/subscription.service.ts#applySubscriptionState, from a
// signature-verified LemonSqueezy webhook or a direct read of their API. One
// writer is what stops the mirrored `plan` field on the user drifting from the
// subscription that paid for it.

export async function toggleWishlist(userId: string, courseId: string): Promise<UserProfile> {
  const user = await UserModel.findById(userId);
  if (!user) throw new ApiError(404, "User not found");
  const doc = user as unknown as UserDoc;
  const current = doc.wishlistCourseIds ?? [];
  const wishlistCourseIds = current.includes(courseId)
    ? current.filter((id) => id !== courseId)
    : [...current, courseId];

  return assemble(
    await UserModel.findByIdAndUpdate(userId, { wishlistCourseIds }, { new: true }),
    userId,
  );
}
