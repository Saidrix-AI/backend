import { z } from "zod";

// Single source of the content-language contract. The student picks one during
// the guided intake (services/intake.service.ts) and it then drives every
// generation prompt: the knowledge check, the course curriculum and the lecture
// pages. Before this existed, each prompt guessed the language from the script
// of whatever the student typed, which quietly produced English courses for
// students who asked in a different language.
//
// THE SET IS OPEN FOR WRITING, CLOSED FOR SPEAKING. A student who types
// "Swahili" into the free-text box still gets a course WRITTEN in Swahili —
// the model writes whatever resolveLanguage hands it, and nothing downstream
// needs a table. But the tutor has to SAY it out loud, and the speech models
// support a fixed list (SPEECH_LANGUAGES below). A language we cannot speak is
// one where the whole product is a document, so the intake asks again rather
// than letting a student build a course they will meet in silence.
//
// KNOWN_LANGUAGES is therefore what we can *recognise*; SPEECH_LANGUAGES is
// what we can *teach in*. The first is the wider list on purpose: recognising
// Nepali is what lets us say "not Nepali — how about Hindi?" instead of
// quietly slugging it and moving on.
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
 *
 * Ordered by how often they are likely to be asked for, not alphabetically —
 * `resolveLanguage` walks this list and the first alias match wins.
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
  // Recognised but NOT speakable — kept here precisely so the intake can name
  // it back to the student and offer its neighbours. See SPEECH_LANGUAGES.
  { code: "ne", label: "नेपाली (Nepali)", aliases: /^(ne|nepali|नेपाली)$/i },
  { code: "zh", label: "中文 (Chinese)", aliases: /^(zh|chinese|mandarin|中文|putonghua)$/i },
  { code: "ja", label: "日本語 (Japanese)", aliases: /^(ja|jp|japanese|日本語|nihongo)$/i },
  { code: "ko", label: "한국어 (Korean)", aliases: /^(ko|korean|한국어|hangul)$/i },
  { code: "ru", label: "Русский (Russian)", aliases: /^(ru|russian|русский)$/i },
  { code: "tr", label: "Türkçe (Turkish)", aliases: /^(tr|turkish|turkce|türkçe)$/i },
  { code: "vi", label: "Tiếng Việt (Vietnamese)", aliases: /^(vi|vietnamese|tieng viet|tiếng việt)$/i },
  // --- the rest of what the tutor can speak ---
  { code: "it", label: "Italiano (Italian)", aliases: /^(it|italian|italiano)$/i },
  { code: "nl", label: "Nederlands (Dutch)", aliases: /^(nl|dutch|nederlands|flemish)$/i },
  { code: "pl", label: "Polski (Polish)", aliases: /^(pl|polish|polski)$/i },
  { code: "uk", label: "Українська (Ukrainian)", aliases: /^(uk|ua|ukrainian|українська)$/i },
  { code: "sv", label: "Svenska (Swedish)", aliases: /^(sv|se|swedish|svenska)$/i },
  { code: "da", label: "Dansk (Danish)", aliases: /^(da|dk|danish|dansk)$/i },
  { code: "no", label: "Norsk (Norwegian)", aliases: /^(no|nb|nn|norwegian|norsk|bokmal|bokmål)$/i },
  { code: "fi", label: "Suomi (Finnish)", aliases: /^(fi|finnish|suomi)$/i },
  { code: "cs", label: "Čeština (Czech)", aliases: /^(cs|cz|czech|cestina|čeština)$/i },
  { code: "sk", label: "Slovenčina (Slovak)", aliases: /^(sk|slovak|slovencina|slovenčina)$/i },
  { code: "hu", label: "Magyar (Hungarian)", aliases: /^(hu|hungarian|magyar)$/i },
  { code: "ro", label: "Română (Romanian)", aliases: /^(ro|romanian|romana|română)$/i },
  { code: "bg", label: "Български (Bulgarian)", aliases: /^(bg|bulgarian|български)$/i },
  { code: "hr", label: "Hrvatski (Croatian)", aliases: /^(hr|croatian|hrvatski)$/i },
  { code: "el", label: "Ελληνικά (Greek)", aliases: /^(el|gr|greek|ελληνικά|hellenic)$/i },
  { code: "he", label: "עברית (Hebrew)", aliases: /^(he|iw|hebrew|עברית|ivrit)$/i },
  { code: "ka", label: "ქართული (Georgian)", aliases: /^(ka|georgian|ქართული)$/i },
  { code: "th", label: "ไทย (Thai)", aliases: /^(th|thai|ไทย)$/i },
  { code: "ms", label: "Bahasa Melayu (Malay)", aliases: /^(ms|malay|melayu|bahasa melayu|malaysian)$/i },
  { code: "tl", label: "Tagalog (Filipino)", aliases: /^(tl|fil|tagalog|filipino)$/i },
  { code: "mr", label: "मराठी (Marathi)", aliases: /^(mr|marathi|मराठी)$/i },
  { code: "gu", label: "ગુજરાતી (Gujarati)", aliases: /^(gu|gujarati|ગુજરાતી)$/i },
  { code: "kn", label: "ಕನ್ನಡ (Kannada)", aliases: /^(kn|kannada|ಕನ್ನಡ)$/i },
  { code: "ml", label: "മലയാളം (Malayalam)", aliases: /^(ml|malayalam|മലയാളം)$/i },
  { code: "pa", label: "ਪੰਜਾਬੀ (Punjabi)", aliases: /^(pa|pb|punjabi|panjabi|ਪੰਜਾਬੀ)$/i },
  { code: "or", label: "ଓଡ଼ିଆ (Odia)", aliases: /^(or|ory|odia|oriya|ଓଡ଼ିଆ)$/i },
];

/**
 * The languages the tutor can actually SPEAK — Cartesia Sonic-3.6's 44.
 *
 * This is the binding constraint on the whole product, and it is the TTS list
 * rather than the STT one on purpose: Ink-whisper hears 99 languages, so
 * anything Sonic can say, Ink can hear. Being able to listen in a language we
 * cannot answer in is worth nothing.
 *
 * Keep in step with https://docs.cartesia.ai/build-with-cartesia/tts-models/latest
 * — the count is asserted in tests so a silent drift here fails loudly.
 */
export const SPEECH_LANGUAGES: ReadonlySet<string> = new Set([
  "en", "fr", "de", "es", "pt", "zh", "ja", "hi", "it", "ko", "nl", "pl", "ru",
  "sv", "tr", "tl", "bg", "ro", "ar", "cs", "el", "fi", "hr", "ms", "sk", "da",
  "ta", "uk", "hu", "no", "vi", "bn", "th", "he", "ka", "id", "te", "gu", "kn",
  "ml", "mr", "pa", "or", "ur",
]);

/**
 * Whether the tutor can hold a spoken class in this language.
 *
 * False is not a failure — it is the answer the intake gives back to the
 * student before they spend ten minutes building a course. See
 * services/intake.slots.ts.
 */
export function isSpeechSupported(code: Language): boolean {
  return SPEECH_LANGUAGES.has(code);
}

/**
 * Languages LiveKit's turn detector has a tuned threshold for.
 *
 * Everything else still works — the detector falls back to a default threshold
 * and VAD underneath it — but the pause before the tutor answers is less
 * precisely judged. Notably BANGLA IS NOT HERE, so the one language this
 * product was built around gets the untuned path; that is worth knowing when a
 * Bangla class feels like it cuts in early or waits too long.
 *
 * Keep in step with the plugin's languages.json.
 */
const TUNED_TURN_DETECTION: ReadonlySet<string> = new Set([
  "en", "es", "fr", "de", "it", "pt", "nl", "zh", "ja", "ko", "id", "tr", "ru", "hi",
]);

export function hasTunedTurnDetection(code: Language): boolean {
  return TUNED_TURN_DETECTION.has(code);
}

/**
 * Speakable languages to offer someone whose choice we cannot speak.
 *
 * Neighbours first where we know them — a student who asked for Nepali is far
 * better served by Hindi or Bangla than by Spanish — then the card's own four.
 * There is no entry for a language we could not even name, and that is honest:
 * with nothing but a slug there is no basis for guessing what is close to it.
 */
const NEIGHBOURS: Record<string, string[]> = {
  ne: ["hi", "bn", "ur"],
};

export function suggestLanguages(code: Language): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [...(NEIGHBOURS[code] ?? []), ...FALLBACK_SUGGESTIONS]) {
    if (c === code || seen.has(c) || !isSpeechSupported(c)) continue;
    seen.add(c);
    out.push(languageLabel(c));
    if (out.length === 4) break;
  }
  return out;
}

/** The card's own four, as the last resort for a language we know nothing about. */
const FALLBACK_SUGGESTIONS = ["en", "bn", "hi", "es"];

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
