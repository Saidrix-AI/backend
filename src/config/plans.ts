/**
 * The subscription tiers a user can be on.
 *
 * There is deliberately no free tier — every account picks a paid plan during
 * signup, so a user with no plan yet is represented by `null`, not by "free".
 *
 * Pricing and feature copy live on the client (`frontend/src/lib/plans.js`);
 * the server only needs to know which ids are valid, so the two never have to be
 * kept in sync beyond these three strings.
 */
export const PLAN_IDS = ["basic", "pro", "premium"] as const;

export type PlanId = (typeof PLAN_IDS)[number];

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);
}
