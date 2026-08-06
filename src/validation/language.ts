import { z } from "zod";

// Single source of the content-language contract. The student picks one during
// the guided intake (services/intake.service.ts) and it then drives every
// generation prompt: the knowledge check, the course curriculum and the lecture
// pages. Before this existed, each prompt guessed the language from the script
// of whatever the student typed, which quietly produced English courses for
// students who asked in Banglish.

export const LANGUAGES = ["en", "bn", "bn-latn"] as const;
export type Language = (typeof LANGUAGES)[number];
export const languageSchema = z.enum(LANGUAGES);

export const DEFAULT_LANGUAGE: Language = "en";

/** What the student sees on the language card — also the stored answer text. */
export const LANGUAGE_LABELS: Record<Language, string> = {
  en: "English",
  bn: "বাংলা (Bangla)",
  "bn-latn": "Banglish (Bangla in English letters)",
};

const LANGUAGE_RULES: Record<Language, string> = {
  en: "Write everything in English.",
  bn: "Write everything in Bangla, in Bangla script (বাংলা). Do not switch to English prose or to Latin letters.",
  "bn-latn":
    'Write everything in Banglish — the Bangla language typed in Latin/English letters (e.g. "loop mane ki bujhcho?"). ' +
    "Never use Bangla script, and do not fall back to plain English sentences.",
};

/**
 * Kept out of the per-language rules because it is true for all of them: a
 * Bangla lecture whose code samples or keywords get translated is worthless.
 */
const CODE_RULE =
  "Code, code comments, identifiers, command names, library/API names and standard technical terms " +
  "always stay in English — only the explanation prose is written in the chosen language.";

/** The LANGUAGE line every generation prompt carries. */
export function languageInstruction(language: Language): string {
  return `LANGUAGE: ${LANGUAGE_RULES[language]} ${CODE_RULE}`;
}

const ALIASES: [RegExp, Language][] = [
  [/bangl[ia]sh|benglish|bn-?latn|latin/i, "bn-latn"],
  [/বাংলা|bangla|bengali|bn\b/i, "bn"],
  [/english|ingreji|en\b/i, "en"],
];

/**
 * The language card's answer back to a code. Options are the labels above, but
 * the cards also accept typed free text, so aliases are matched too. Banglish is
 * tested first: "Banglish (Bangla in English letters)" contains all three words.
 */
export function parseLanguage(answer: string): Language | null {
  const text = answer.trim();
  if (!text) return null;
  for (const [pattern, code] of ALIASES) {
    if (pattern.test(text)) return code;
  }
  return null;
}
