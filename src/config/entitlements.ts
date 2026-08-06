import { env } from "./env.js";
import { PLAN_IDS, type PlanId } from "./plans.js";

/**
 * What each tier is actually allowed to do.
 *
 * The server's source of truth. `frontend/src/lib/plans.js` carries a mirror of
 * these numbers to write its feature copy — `tests/entitlements-parity.test.ts`
 * reads that file and fails if the two ever disagree, because they did drift
 * once already (see the header comment on plans.js).
 *
 * Every limit is enforced somewhere:
 *   activePaths       services/activeSelection.service.ts  (checked on activate only)
 *   activeCourses     services/activeSelection.service.ts  (standalone commitments)
 *   coursesPerMonth   agents/course-maker/index.ts         (before the first LLM call)
 *   reviewsPerProject services/projectReview.service.ts    (lifetime, per project)
 *
 * `interviewsPerRole` is the exception: "Job Ready Interview" is advertised but
 * does not exist as a feature yet, so the number is recorded here for whoever
 * builds it and nothing reads it.
 */
export interface Entitlements {
  /** Learning paths that may be committed to at the same time. */
  activePaths: number;
  /** Path-less courses that may be committed to at the same time. */
  activeCourses: number;
  /** New AI-generated courses per billing month. Manual courses are free. */
  coursesPerMonth: number;
  /** Review submissions per project, for the lifetime of that project. */
  reviewsPerProject: number;
  /** Not enforced — the feature does not exist. */
  interviewsPerRole: number;
}

export const ENTITLEMENTS: Record<PlanId, Entitlements> = {
  basic: {
    activePaths: 1,
    activeCourses: 1,
    coursesPerMonth: 3,
    reviewsPerProject: 2,
    interviewsPerRole: 1,
  },
  pro: {
    activePaths: 2,
    activeCourses: 1,
    coursesPerMonth: 8,
    reviewsPerProject: 5,
    interviewsPerRole: 3,
  },
  premium: {
    activePaths: 3,
    activeCourses: 1,
    coursesPerMonth: 15,
    reviewsPerProject: 8,
    interviewsPerRole: 5,
  },
};

/**
 * The limits to apply to a user.
 *
 * A user with no plan falls back to Basic's numbers rather than to zero. They
 * cannot reach any of these call sites anyway — the paywall stops them at the
 * router — so this only decides what an unreachable code path would compute,
 * and "the smallest real tier" is a safer answer than "nothing is allowed",
 * which would turn a billing hiccup into data the student cannot open.
 */
export function entitlementsFor(plan: PlanId | null | undefined): Entitlements {
  return ENTITLEMENTS[plan ?? "basic"] ?? ENTITLEMENTS.basic;
}

// ---------------------------------------------------------------------------
// LemonSqueezy variant mapping
// ---------------------------------------------------------------------------

export const BILLING_PERIODS = ["monthly", "yearly"] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export function isBillingPeriod(value: unknown): value is BillingPeriod {
  return typeof value === "string" && (BILLING_PERIODS as readonly string[]).includes(value);
}

export interface PlanVariant {
  plan: PlanId;
  billing: BillingPeriod;
}

/**
 * Which env var holds each (plan, period) variant id. Three LemonSqueezy
 * products with two variants each, so six ids in all.
 */
const VARIANT_ENV_KEYS: Record<PlanId, Record<BillingPeriod, keyof typeof env>> = {
  basic: { monthly: "LS_VARIANT_BASIC_MONTHLY", yearly: "LS_VARIANT_BASIC_YEARLY" },
  pro: { monthly: "LS_VARIANT_PRO_MONTHLY", yearly: "LS_VARIANT_PRO_YEARLY" },
  premium: { monthly: "LS_VARIANT_PREMIUM_MONTHLY", yearly: "LS_VARIANT_PREMIUM_YEARLY" },
};

/**
 * variant id -> what it entitles the buyer to.
 *
 * Built once at startup from the env. Ids are compared as strings because
 * LemonSqueezy sends them as numbers in webhooks and as strings in the API.
 */
const PLAN_BY_VARIANT = new Map<string, PlanVariant>();
for (const plan of PLAN_IDS) {
  for (const billing of BILLING_PERIODS) {
    const id = env[VARIANT_ENV_KEYS[plan][billing]];
    if (typeof id === "string" && id.trim()) PLAN_BY_VARIANT.set(id.trim(), { plan, billing });
  }
}

/**
 * What a purchased variant grants, or null when the id is not one of ours.
 *
 * Null is deliberate and must never be coerced into a tier: an unrecognised
 * variant means someone bought a product we do not know about (a leftover test
 * product, a renamed variant, a store we do not own), and guessing would hand
 * out a subscription nobody paid the right price for.
 */
export function planForVariant(variantId: string | number | null | undefined): PlanVariant | null {
  if (variantId === null || variantId === undefined) return null;
  return PLAN_BY_VARIANT.get(String(variantId)) ?? null;
}

/** The variant id to send a buyer of this tier to. */
export function variantFor(plan: PlanId, billing: BillingPeriod): string | null {
  const id = env[VARIANT_ENV_KEYS[plan][billing]];
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/** True once all six variant ids are configured. */
export function hasAllVariants(): boolean {
  return PLAN_BY_VARIANT.size === PLAN_IDS.length * BILLING_PERIODS.length;
}
