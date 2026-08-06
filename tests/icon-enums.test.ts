import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BRAND_ICON_NAMES,
  COURSE_ICON_NAMES,
  ICON_NAMES,
} from "../src/validation/course.schema.js";
import { ICON_NAMES as LECTURE_ICON_NAMES } from "../src/agents/lecture-maker/schema.js";

const frontendFile = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../frontend/src/components/blocks/${rel}`, import.meta.url)), "utf8");

describe("icon enums", () => {
  it("has no duplicates within or across the two lists", () => {
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
    expect(new Set(BRAND_ICON_NAMES).size).toBe(BRAND_ICON_NAMES.length);

    const overlap = ICON_NAMES.filter((n) => (BRAND_ICON_NAMES as readonly string[]).includes(n));
    expect(overlap).toEqual([]);

    expect(new Set(COURSE_ICON_NAMES).size).toBe(ICON_NAMES.length + BRAND_ICON_NAMES.length);
  });

  // The lecture-maker used to redeclare its own icon list, which silently drifted
  // four names behind the course contract. Identity — not just equal contents —
  // is what makes that impossible to reintroduce.
  it("gives the lecture-maker the generic list itself, not a copy", () => {
    expect(LECTURE_ICON_NAMES).toBe(ICON_NAMES);
  });

  it("keeps brand marks out of lecture callouts", () => {
    for (const brand of BRAND_ICON_NAMES) {
      expect(LECTURE_ICON_NAMES as readonly string[]).not.toContain(brand);
    }
  });

  /** The body of a top-level `const NAME = { ... }` object literal. */
  const objectLiteral = (source: string, constName: string) => {
    const start = source.indexOf(`const ${constName} = {`);
    expect(start, `${constName} not found`).toBeGreaterThan(-1);
    const end = source.indexOf("\n}", start);
    return source.slice(start, end);
  };

  // The enums are only worth anything if the frontend can actually draw them.
  it("every enum name resolves to a glyph in the frontend registries", () => {
    const iconsBlock = objectLiteral(frontendFile("iconRegistry.js"), "ICONS");
    const brandsBlock = objectLiteral(frontendFile("brandIcons.js"), "BRAND_ICONS");

    for (const name of ICON_NAMES) {
      expect(iconsBlock, `generic icon "${name}" missing from ICONS`).toMatch(
        new RegExp(`^\\s*${name}:`, "m"),
      );
    }
    for (const name of BRAND_ICON_NAMES) {
      expect(brandsBlock, `brand icon "${name}" missing from BRAND_ICONS`).toMatch(
        new RegExp(`^\\s*${name}:`, "m"),
      );
    }
  });

  // Colour is not optional any more: a name with a glyph but no tokens renders on
  // the model's `thumb` fallback, which is exactly the monochrome catalog this
  // replaced. Brands carry their colours inline; generics need their own map.
  it("every generic name also has a colour token", () => {
    const tokensBlock = objectLiteral(frontendFile("iconRegistry.js"), "GENERIC_TOKENS");
    for (const name of ICON_NAMES) {
      expect(tokensBlock, `generic icon "${name}" missing from GENERIC_TOKENS`).toMatch(
        new RegExp(`^\\s*${name}: \\{ fg:`, "m"),
      );
    }
  });
});
