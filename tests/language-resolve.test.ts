import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_OPTIONS,
  SPEECH_LANGUAGES,
  hasTunedTurnDetection,
  isSpeechSupported,
  languageInstruction,
  languageLabel,
  localized,
  resolveLanguage,
  suggestLanguages,
} from "../src/validation/language.js";

// The language set is OPEN FOR WRITING: the card offers four, the free-text box
// takes anything, and a student who typed "Japanese" used to get an English
// course. It is CLOSED FOR SPEAKING — the tutor can only say the 44 the speech
// model knows — and the difference between those two lists is what the intake's
// re-ask is built on.

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

describe("what the tutor can actually speak", () => {
  // Pinned so a silent edit to the table fails here rather than at the moment a
  // student is sitting in a classroom waiting to be spoken to.
  it("is Sonic-3.6's 44 languages", () => {
    expect(SPEECH_LANGUAGES.size).toBe(44);
  });

  it("covers the four on the card", () => {
    for (const label of LANGUAGE_OPTIONS) {
      expect(isSpeechSupported(resolveLanguage(label).code), label).toBe(true);
    }
  });

  it("speaks Bangla, which is the whole reason for leaving Deepgram", () => {
    expect(isSpeechSupported("bn")).toBe(true);
  });

  // The one language we can NAME but not SPEAK. Kept in the recognised table
  // precisely so the intake can say "not Nepali" instead of slugging it.
  it("cannot speak Nepali, and still recognises it", () => {
    expect(resolveLanguage("Nepali").code).toBe("ne");
    expect(isSpeechSupported("ne")).toBe(false);
  });

  it("cannot speak a language it has never heard of", () => {
    expect(isSpeechSupported(resolveLanguage("Swahili").code)).toBe(false);
  });

  // Every recognised language should be speakable, or there is a reason. Nepali
  // is that reason; a second one appearing here means the table drifted.
  it("recognises nothing unspeakable except Nepali", () => {
    const named = ["en", "bn", "hi", "es", "ar", "ur", "fr", "de", "pt", "id", "ta", "te",
      "ne", "zh", "ja", "ko", "ru", "tr", "vi", "it", "nl", "pl", "uk", "sv", "da", "no",
      "fi", "cs", "sk", "hu", "ro", "bg", "hr", "el", "he", "ka", "th", "ms", "tl", "mr",
      "gu", "kn", "ml", "pa", "or"];
    expect(named.filter((c) => !isSpeechSupported(c))).toEqual(["ne"]);
  });
});

describe("turn detection", () => {
  // Not a bug — a warning. The detector falls back to a default threshold for
  // everything else, and this is the one place that says which languages get
  // the tuned path.
  it("is tuned for English and Hindi but NOT for Bangla", () => {
    expect(hasTunedTurnDetection("en")).toBe(true);
    expect(hasTunedTurnDetection("hi")).toBe(true);
    expect(hasTunedTurnDetection("bn")).toBe(false);
  });

  it("only claims tuning for languages we can speak at all", () => {
    for (const code of ["en", "es", "fr", "de", "it", "pt", "nl", "zh", "ja", "ko", "id", "tr", "ru", "hi"]) {
      expect(isSpeechSupported(code), code).toBe(true);
    }
  });
});

describe("suggestLanguages", () => {
  it("offers neighbours first for a language we know but cannot speak", () => {
    const picks = suggestLanguages("ne");
    expect(picks[0]).toContain("Hindi");
    expect(picks[1]).toContain("Bangla");
  });

  it("falls back to the card's four when there is nothing to go on", () => {
    // A slug carries no family information, so guessing would be invention.
    expect(suggestLanguages("swahili")).toEqual(LANGUAGE_OPTIONS);
  });

  it("never suggests the language that was just refused, or one we cannot speak", () => {
    for (const code of ["ne", "swahili", "en"]) {
      const picks = suggestLanguages(code);
      expect(picks).not.toContain(languageLabel(code));
      for (const label of picks) {
        expect(isSpeechSupported(resolveLanguage(label).code), label).toBe(true);
      }
    }
  });

  it("gives at most four, all different", () => {
    const picks = suggestLanguages("ne");
    expect(picks.length).toBeLessThanOrEqual(4);
    expect(new Set(picks).size).toBe(picks.length);
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
