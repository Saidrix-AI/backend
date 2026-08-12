import { Schema, model, Types, type InferSchemaType } from "mongoose";
import { PLAN_IDS } from "../../config/plans.js";
/**
 * Languages a student may say they are comfortable in — a fixed picker list,
 * unlike the open content-language set in validation/language.ts. Recorded
 * only; picking one changes nothing about what gets generated. See the note on
 * `preferredLanguages` below.
 *
 * "bn-latn" (Banglish) was removed 2026-08-07 — it is Bangla, not a separate
 * language. scripts/migrate-drop-banglish.ts folds stored values into "bn".
 */
export const PREFERRED_LANGUAGES = ["en", "bn", "hi", "es", "ar"] as const;

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },
    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date },
    // Brute-force protection: incremented on failed login, reset on success.
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date },

    // --- Editable profile fields ---
    role: { type: String, default: "Learner", trim: true },
    phone: { type: String, trim: true, default: "" },
    dateOfBirth: { type: Date },
    country: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "", maxlength: 200 },
    timezone: { type: String, trim: true, default: "" },
    /** Free text ("English") shown on the profile. Display only. */
    language: { type: String, trim: true, default: "" },
    /**
     * A RECORD of the languages they said they are comfortable in, not a setting
     * that is applied. Generation still asks at creation time
     * (services/intake.service.ts owns the content language); this is what that
     * question offers as the suggestion.
     *
     * Its own vocabulary, NOT validation/language.ts's: that enum is the set the
     * app can actually write a lecture in, and this list is wider (a student who
     * reads Hindi is worth knowing about even though no Hindi lecture exists).
     * Conflating them would advertise generation the app cannot do.
     *
     * Empty = "no preference", which is why the UI's "No preference" chip stores
     * nothing rather than a sentinel value.
     */
    preferredLanguages: { type: [String], enum: PREFERRED_LANGUAGES, default: [] },
    /**
     * Superseded 2026-08-03 by the array above, kept so profiles written before
     * that keep their answer — toProfile falls back to it when the array is
     * empty. Nothing writes it any more.
     */
    preferredLanguage: { type: String, default: "" },
    /**
     * Where they heard about Saidrix. Lives here rather than on LearnerProfile on
     * purpose: it is marketing attribution and must never reach a prompt, and
     * everything on LearnerProfile does reach one.
     */
    referralSource: { type: String, trim: true, default: "", maxlength: 60 },
    bio: { type: String, trim: true, default: "", maxlength: 500 },
    // Base64 data URL (size-capped in the route). Empty = use initials fallback.
    avatar: { type: String, default: "" },
    // Course ids the user has bookmarked from the Courses page.
    wishlistCourseIds: { type: [String], default: [] },

    // --- Subscription ---
    // There is no free tier, so a fresh account has no plan until it pays for
    // one; `null` means "not subscribed", never "free".
    //
    // These four fields are a MIRROR of the Subscription document, denormalised
    // so the paywall middleware can decide on the user row it already has
    // instead of a second query per request. They have exactly one writer —
    // services/subscription.service.ts#applySubscriptionState, reached only
    // from a signature-verified webhook or a direct read of the LemonSqueezy
    // API. Nothing else may write them: the self-serve `PUT /user/plan` that
    // used to do so was the entire billing system, and handed out Premium free.
    plan: { type: String, enum: [...PLAN_IDS, null], default: null },
    planSince: { type: Date, default: null },
    /**
     * Whether the plan currently opens the app.
     *   none             — never subscribed, or the subscription is gone
     *   active           — paying, on trial, or a PROVEN payer inside retries
     *   grace            — cancelled but still inside the period they paid for
     *   payment_required — never paid and the charge failed; see below
     *   lapsed           — expired, unpaid or paused; the app is closed
     *
     * `payment_required` and `lapsed` both close the app, so to the paywall
     * they are the same answer. They are kept apart because they lead to
     * different pages: a failed trial holds a `plan` and a subscription that
     * has never worked, so sending it to the billing page to "renew" would be
     * nonsense. It belongs on /complete-payment.
     */
    planStatus: {
      type: String,
      enum: ["none", "active", "grace", "payment_required", "lapsed"],
      default: "none",
    },
    /** When `grace` runs out. Checked directly, so a missed expiry webhook
     *  cannot leave a cancelled account open indefinitely. */
    planExpiresAt: { type: Date, default: null },
    /**
     * When the free trial ends, while one is running. Null otherwise.
     *
     * Mirrored here for the same reason as the fields above: the session
     * payload carries it so the countdown banner paints on first render, and
     * reading it off the user row the request already loaded beats a second
     * query on every login. `Subscription.trialEndsAt` remains the truth.
     */
    trialEndsAt: { type: Date, default: null },
    /**
     * When this account started a free trial, or null if it never has.
     *
     * One-way and never cleared: it is the whole defence against taking the
     * 1-day trial over and over. Cancelling a trial leaves `planStatus` in
     * `lapsed`/`none`, which billing.controller.ts#checkout happily allows a
     * fresh checkout from — so without this the same account could trial
     * forever, free.
     *
     * Written by exactly one function, the same one that owns the plan mirror
     * above: services/subscription.service.ts#applySubscriptionState, reached
     * only from a signature-verified webhook or a direct read of the
     * LemonSqueezy API. Nothing a browser sends may touch it.
     */
    trialConsumedAt: { type: Date, default: null },

    /**
     * A short-lived reservation held while a checkout URL is being requested.
     * Two concurrent `POST /billing/checkout` calls (double-click, two tabs)
     * would otherwise both pass the "no subscription yet" check and both mint
     * a valid LemonSqueezy checkout, producing two real charges. Claimed
     * atomically in billing.controller.ts#checkout and cleared once the
     * checkout URL is returned or the request fails.
     */
    checkoutLockedUntil: { type: Date, default: null },

    // --- Finish-profile setup (the dashboard popup) ---
    // Absent on every account that predates the feature, which is exactly right:
    // an absent sub-document reads as "not finished", so existing users are
    // offered it once on their next login without needing a migration.
    profileSetup: {
      /** Resume point: 0 = the step-1 form, 1 = the step-2 questions. */
      step: { type: Number, min: 0, max: 1, default: 0 },
      completedAt: { type: Date, default: null },
      /** Set by "Later". Stops the auto-popup; the dashboard banner remains. */
      skippedAt: { type: Date, default: null },
    },

    // --- Active selection: WHICH paths (and standalone course) are active now ---
    // The pointers live here rather than as an `isActive` flag on each path, so
    // "how many are active" is a property of a single document and holds
    // without a transaction. The 3-day locks live on the paths/courses
    // themselves, because each one carries its own cooldown — see
    // services/activeSelection.service.ts.
    //
    // How many paths may be in this array is the plan's business
    // (config/entitlements.ts: 1/2/3), and it is enforced when activating, not
    // stored here — a downgrade must leave a Premium user's three running paths
    // alone and only refuse the next one.
    activePathIds: { type: [Types.ObjectId], ref: "LearningPath", default: [] },
    // Course _id as a string, matching Enrollment.courseId's convention. One on
    // every tier, and independent of the paths above: a path-less course does
    // not compete with a path for a slot.
    activeCourseId: { type: String, default: null },
    /** When the standalone course was committed to. Paths carry their own
     *  `activatedAt`, so this no longer speaks for them. */
    activeSince: { type: Date, default: null },
  },
  { timestamps: true },
);

export type User = InferSchemaType<typeof userSchema>;
export const UserModel = model("User", userSchema);
