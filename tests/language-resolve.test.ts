import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_OPTIONS,
  languageInstruction,
  languageLabel,
  localized,
  resolveLanguage,
} from "../src/validation/language.js";

// The language set is OPEN: the card offers four, the free-text box takes
// anything. The bug this replaces silently turned every unrecognised answer
// into English, so a student who typed "Japanese" got an English course.

describe("LANGUAGE_OPTIONS", () => {
  it("offers exactly four genuinely different languages", () => {
    expect(LANGUAGE_OPTIONS).toHaveLength(4);
    expect(new Set(LANGUAGE_OPTIONS).size).toBe(4);
  });

  // The whole point of the redesign: Bangla and Banglish are one language.
  it("never offers the same language twice", () => {
    const banglaish = LANGUAGE_OPTIONS.filter((l) => /bangla|বাংলা|banglish/i.test(l));
    expect(banglaish).toHaveLength(1);
  });

  it("round-trips every option back to a distinct code", () => {
    const codes = LANGUAGE_OPTIONS.map((label) => resolveLanguage(label).code);
    expect(codes).toEqual(["en", "bn", "hi", "es"]);
  });
});

describe("resolveLanguage", () => {
  it("matches a card label with its parenthetical gloss", () => {
    expect(resolveLanguage("বাংলা (Bangla)").code).toBe("bn");
    expect(resolveLanguage("Español (Spanish)").code).toBe("es");
  });

  it("matches loose free text and codes", () => {
    expect(resolveLanguage("  hindi ").code).toBe("hi");
    expect(resolveLanguage("SPANISH").code).toBe("es");
    expect(resolveLanguage("bn").code).toBe("bn");
  });

  // Banglish is gone as a language but must not become a dead end: someone who
  // types it means Bangla.
  it("folds banglish into Bangla", () => {
    expect(resolveLanguage("banglish").code).toBe("bn");
    expect(resolveLanguage("Benglish").code).toBe("bn");
    expect(resolveLanguage("bn-latn").code).toBe("bn");
  });

  it("honours a known language that is not on the card", () => {
    const ja = resolveLanguage("Japanese");
    expect(ja.code).toBe("ja");
    expect(ja.label).toContain("Japanese");
    expect(resolveLanguage("العربية").code).toBe("ar");
  });

  // The regression the open set exists for.
  it("keeps a language we have no entry for instead of falling back to English", () => {
    const sw = resolveLanguage("Swahili");
    expect(sw.code).not.toBe(DEFAULT_LANGUAGE);
    expect(sw.code).toBe("swahili");
    expect(sw.label).toBe("Swahili");
    // The stored code must reconstruct a usable name for the prompt.
    expect(languageLabel(sw.code)).toBe("Swahili");
  });

  it("falls back to English only for empty or implausible answers", () => {
    expect(resolveLanguage("").code).toBe("en");
    expect(resolveLanguage("   ").code).toBe("en");
    expect(resolveLanguage("!!!").code).toBe("en");
    expect(resolveLanguage("please write it in whatever you think is best for me").code).toBe("en");
  });
});

describe("languageInstruction", () => {
  it("names the language and keeps code in English", () => {
    const line = languageInstruction("bn");
    expect(line).toContain("বাংলা");
    expect(line).toContain("always stay in English");
  });

  it("works for a language with no table entry", () => {
    expect(languageInstruction("swahili")).toContain("Swahili");
  });

  it("does not tell an English course to avoid English prose", () => {
    expect(languageInstruction("en")).toContain("Write everything in English");
    expect(languageInstruction("en")).not.toContain("Do not switch to English prose");
  });
});

describe("localized", () => {
  const map = { en: "Resources", bn: "আরও জানতে" };

  it("picks the translation when there is one", () => {
    expect(localized(map, "bn")).toBe("আরও জানতে");
  });

  // A student who typed an off-table language gets model-written prose under an
  // English heading rather than an empty one.
  it("falls back to English for anything else", () => {
    expect(localized(map, "swahili")).toBe("Resources");
  });
});
