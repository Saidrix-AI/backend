import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENTITLEMENTS } from "../src/config/entitlements.js";
import { PLAN_IDS } from "../src/config/plans.js";

/**
 * The marketing numbers must equal the enforced numbers.
 *
 * `frontend/src/lib/plans.js` carries a `LIMITS` mirror of ENTITLEMENTS, used
 * to WRITE the feature bullets rather than typing them out beside the code that
 * refuses requests. This is what stops the two drifting — the same failure that
 * once had the app advertising three tiers on the landing page and four inside
 * the account, at different prices.
 *
 * Parsed rather than imported: the frontend is a separate package with its own
 * module resolution, and reaching into it with an import would tie the server's
 * build to the browser bundle's.
 */

const PLANS_JS = new URL("../../frontend/src/lib/plans.js", import.meta.url);

/** Pulls `LIMITS` out of the source without evaluating the module. */
function readFrontendLimits(): Record<string, Record<string, number>> {
  const source = readFileSync(PLANS_JS, "utf8");
  const block = source.match(/const LIMITS = \{([\s\S]*?)\n\}/);
  if (!block) {
    throw new Error(
      "Could not find `const LIMITS = { … }` in frontend/src/lib/plans.js. " +
        "If it was renamed or restructured, update this test — do not delete it.",
    );
  }

  const limits: Record<string, Record<string, number>> = {};
  for (const line of block[1].split("\n")) {
    const row = line.match(/^\s*(\w+):\s*\{(.+)\},?\s*$/);
    if (!row) continue;
    const fields: Record<string, number> = {};
    for (const [, key, value] of row[2].matchAll(/(\w+):\s*(\d+)/g)) {
      fields[key] = Number(value);
    }
    limits[row[1]] = fields;
  }
  return limits;
}

describe("frontend plan limits mirror the server's entitlements", () => {
  const frontend = readFrontendLimits();

  it("names every tier", () => {
    expect(Object.keys(frontend).sort()).toEqual([...PLAN_IDS].sort());
  });

  for (const plan of PLAN_IDS) {
    it(`${plan} matches`, () => {
      const mine = ENTITLEMENTS[plan];
      const theirs = frontend[plan];
      expect(theirs, `frontend plans.js has no LIMITS.${plan}`).toBeDefined();
      // Compared key by key so a failure names the number that drifted.
      for (const [key, value] of Object.entries(mine)) {
        expect(theirs[key], `${plan}.${key}`).toBe(value);
      }
      // And no extra keys, so a limit added to the copy without being enforced
      // is caught rather than silently advertised.
      expect(Object.keys(theirs).sort()).toEqual(Object.keys(mine).sort());
    });
  }
});
