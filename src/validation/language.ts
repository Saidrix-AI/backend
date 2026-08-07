import { z } from "zod";

// Single source of the content-language contract. The student picks one during
// the guided intake (services/intake.service.ts) and it then drives every
// generation prompt: the knowledge check, the course curriculum and the lecture
// pages. Before this existed, each prompt guessed the language from the script
// of whatever the student typed, which quietly produced English courses for
// students who asked in a different language.
//
// THE SET IS OPEN. The card offers four languages (LANGUAGE_OPTIONS) but every
// question in the dock also carries a free-text box, and a student who types
// "Japanese" or "Swahili" there gets a course in that language rather than
// being silently downgraded to English. KNOWN_LANGUAGES is therefore what we
// can *recognise*, not what we can *write* — the model writes whatever
// resolveLanguage hands it.
//
// Banglish was removed 2026-08-07 (it is Bangla, not a separate language, and
// offering both on one card confused everyone). "banglish" still resolves — to
// Bangla. See scripts/migrate-drop-banglish.ts for the stored values.

/** A resolved content language: a stable code and the name to write prose in. */
export interface LanguageEntry {
  code: string;
  label: string;
}

/**
 * A language is stored as its code. It is a plain string rather than a union
 * because the set is open — see the note above. Kept as a named type so the
 * intent is readable at every call site.
 */
export type Language = string;

export const DEFAULT_LANGUAGE: Language = "en";
export const DEFAULT_LANGUAGE_LABEL = "English";

/**
 * The languages we can name ourselves. Wider than the card on purpose: these
 * are the ones where we know the endonym and the common misspellings, so a
 * typed answer lands on a stable code instead of a slug.
 */
const KNOWN_LANGUAGES: { code: string; label: string; aliases: RegExp }[] = [
  { code: "en", label: "English", aliases: /^(en|eng|english|ingreji|ingrezi)$/i },
  // "banglish"/"benglish" deliberately resolve here: it is Bangla typed in
  // Latin letters, and it used to be a separate stored language.
  { code: "bn", label: "বাংলা (Bangla)", aliases: /^(bn|bangla|bengali|বাংলা|bangl[ia]sh|benglish|bn-latn)$/i },
  { code: "hi", label: "हिन्दी (Hindi)", aliases: /^(hi|hindi|हिन्दी|hindustani)$/i },
  { code: "es", label: "Español (Spanish)", aliases: /^(es|esp|spanish|espanol|español|castellano)$/i },
  { code: "ar", label: "العربية (Arabic)", aliases: /^(ar|arabic|العربية|arabi)$/i },
  { code: "ur", label: "اردو (Urdu)", aliases: /^(ur|urdu|اردو)$/i },
  { code: "fr", label: "Français (French)", aliases: /^(fr|french|francais|français)$/i },
  { code: "de", label: "Deutsch (German)", aliases: /^(de|german|deutsch)$/i },
  { code: "pt", label: "Português (Portuguese)", aliases: /^(pt|portuguese|portugues|português)$/i },
  { code: "id", label: "Bahasa Indonesia", aliases: /^(id|indonesian|bahasa|bahasa indonesia)$/i },
  { code: "ta", label: "தமிழ் (Tamil)", aliases: /^(ta|tamil|தமிழ்)$/i },
  { code: "te", label: "తెలుగు (Telugu)", aliases: /^(te|telugu|తెలుగు)$/i },
  { code: "ne", label: "नेपाली (Nepali)", aliases: /^(ne|nepali|नेपाली)$/i },
  { code: "zh", label: "中文 (Chinese)", aliases: /^(zh|chinese|mandarin|中文|putonghua)$/i },
  { code: "ja", label: "日本語 (Japanese)", aliases: /^(ja|jp|japanese|日本語|nihongo)$/i },
  { code: "ko", label: "한국어 (Korean)", aliases: /^(ko|korean|한국어|hangul)$/i },
  { code: "ru", label: "Русский (Russian)", aliases: /^(ru|russian|русский)$/i },
  { code: "tr", label: "Türkçe (Turkish)", aliases: /^(tr|turkish|turkce|türkçe)$/i },
  { code: "vi", label: "Tiếng Việt (Vietnamese)", aliases: /^(vi|vietnamese|tieng viet|tiếng việt)$/i },
];

/**
 * The four shown on the intake's language card. Deliberately a different list
 * from KNOWN_LANGUAGES: this is what we OFFER, that is what we RECOGNISE. Every
 * question card also has a free-text box, so anything else is one keystroke
 * away — a card of twenty options would be worse for the ninety-odd percent.
 */
export const LANGUAGE_OPTIONS: string[] = ["en", "bn", "hi", "es"].map(
  (code) => KNOWN_LANGUAGES.find((l) => l.code === code)!.label,
);

/** Code → the name prose should be written in. Unknown codes reconstruct their own. */
export function languageLabel(code: Language): string {
  const known = KNOWN_LANGUAGES.find((l) => l.code === code);
  if (known) return known.label;
  return titleCase(code.replace(/[-_]+/g, " ")) || DEFAULT_LANGUAGE_LABEL;
}

/**
 * Backwards-compatible view of the old LANGUAGE_LABELS record. Reads through
 * `languageLabel`, so an unknown code answers for itself rather than throwing.
 */
export const LANGUAGE_LABELS: Record<string, string> = new Proxy(
  {},
  { get: (_t, code: string) => languageLabel(code) },
) as Record<string, string>;

function titleCase(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Free text that could plausibly be a language name: letters (any script),
 * spaces and hyphens only, and short. Guards the open path — without it a
 * student who types a sentence would create a "language" out of it.
 */
const PLAUSIBLE_NAME = /^[\p{L}\p{M}][\p{L}\p{M}\s'-]{1,39}$/u;

/**
 * The language card's answer → a code and a label. Options are the labels
 * above, but the cards also accept typed free text, so aliases are matched too,
 * and an unrecognised-but-plausible name becomes its own language rather than
 * silently falling back to English.
 */
export function resolveLanguage(answer: string): LanguageEntry {
  const text = (answer ?? "").trim();
  if (!text) return { code: DEFAULT_LANGUAGE, label: DEFAULT_LANGUAGE_LABEL };

  // Card labels carry a parenthetical gloss ("বাংলা (Bangla)"); match the whole
  // label first, then each part of it, then the raw text against the aliases.
  const candidates = [text, ...text.split(/[(),/|]+/).map((p) => p.trim())].filter(Boolean);
  for (const known of KNOWN_LANGUAGES) {
    if (known.label.toLowerCase() === text.toLowerCase()) return entry(known);
    if (candidates.some((c) => known.aliases.test(c))) return entry(known);
  }

  if (PLAUSIBLE_NAME.test(text)) {
    const label = titleCase(text);
    return { code: slug(label), label };
  }
  return { code: DEFAULT_LANGUAGE, label: DEFAULT_LANGUAGE_LABEL };
}

function entry(known: { code: string; label: string }): LanguageEntry {
  return { code: known.code, label: known.label };
}

/** A stable, storable code for a language we have no entry for. */
function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

/**
 * Kept out of the language-specific rule because it is true for all of them: a
 * Bangla lecture whose code samples or keywords get translated is worthless.
 */
const CODE_RULE =
  "Code, code comments, identifiers, command names, library/API names and standard technical terms " +
  "always stay in English — only the explanation prose is written in the chosen language.";

/**
 * The LANGUAGE line every generation prompt carries. Templated from the label
 * rather than read out of a per-language table, because the set is open — a
 * table would answer for four languages and leave the rest silently untreated.
 */
export function languageInstruction(language: Language | LanguageEntry): string {
  const label = typeof language === "string" ? languageLabel(language) : language.label;
  if (label === DEFAULT_LANGUAGE_LABEL) {
    return `LANGUAGE: Write everything in English. ${CODE_RULE}`;
  }
  return (
    `LANGUAGE: Write all prose in ${label}, using that language's own native script. ` +
    "Do not switch to English prose, do not transliterate it into Latin letters, and do not " +
    `drift into another language — every sentence the student reads must be ${label}. ${CODE_RULE}`
  );
}

/**
 * A hand-translated UI string picked by language code, falling back to English.
 *
 * Almost everything a student reads is written by a model in whatever language
 * they chose. A few strings are deterministic on purpose — a section heading
 * that failed to generate is a hole in the page, not a degraded sentence — and
 * those can only be pre-translated for languages we have entries for. A student
 * who typed a language outside the table gets model-written prose under an
 * English heading, which is the honest degradation.
 */
export function localized(map: Record<string, string>, code: Language): string {
  return map[code] ?? map[DEFAULT_LANGUAGE] ?? "";
}

/** Permissive: the set is open, so anything storable is valid. */
export const languageSchema = z.string().trim().min(1).max(40);
