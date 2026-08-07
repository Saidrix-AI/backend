import type OpenAI from "openai";
import { LANGUAGE_OPTIONS, languageLabel, type Language } from "../../../validation/language.js";
import type { AskQuestion } from "../types.js";

/**
 * The guided intake as the chat model sees it, plus every question the SERVER
 * writes itself and the parsers that read the answers back.
 *
 * The stages are run by the server (services/intake.service.ts + intake.slots.ts)
 * — this file only holds the tool the model calls to start one, the fixed
 * questions, and the constants the chat router matches on. See
 * ../intake-tools.ts for the implementation.
 *
 * Every parser here is the "jachai" step for its question: the answer is turned
 * into a typed fact, and later slots branch on that fact rather than on raw
 * text. All of them take free text seriously, because the question dock always
 * offers a type-your-own box.
 */

export const startLearningIntakeTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "start_learning_intake",
    description:
      "Start the short guided setup that comes before ANY course is built: the language to write it in, what they want out of it, their computer and editor if the subject needs one, what they already know, their schedule, and whether to build their routine automatically — all shown as interactive cards, one question at a time. It is around 6-11 questions depending on the subject and their answers; the setup questions are skipped for subjects that need no installation. Call this INSTEAD of asking about their goal, level, language or schedule in text or with ask_questions. The student answers in the cards and their full profile comes back to you in a later message — do NOT call generate_course or propose_courses in the same turn.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The subject to be learned, e.g. 'Python for data analysis'" },
        objective: {
          type: "string",
          description: "What the student said they want to learn and why, in their own words",
        },
        scope: {
          type: "string",
          enum: ["single", "multi"],
          description:
            "single when they named one topic; multi for a broad career/path goal that will need several courses",
        },
      },
      required: ["topic", "objective"],
    },
  },
};

/** Tool message after stage 1 is on screen — the turn must end here. */
export function intakeStartedText(stageLabel: string, totalStages: number): string {
  return (
    `The guided intake is now running in the student's chat as interactive cards ` +
    `(stage 1 of ${totalStages}: ${stageLabel}). Do NOT restate the questions as text, do NOT ask ` +
    "anything else, and do NOT create any course yet. End your turn with one short line telling them to " +
    "answer the cards and that you will design their learning path from the answers."
  );
}

/**
 * Tool message when the student already answered the interview for this same
 * topic minutes ago: no cards are shown and the turn carries straight on to the
 * learning path, using what they already told us.
 */
export function intakeAlreadyDoneText(prior: {
  topic: string;
  language: Language;
  goal: string;
  timetable: string;
}): string {
  return (
    `No cards were shown — this student completed the guided setup for "${prior.topic}" a short while ago, ` +
    "so do NOT ask any of it again. Use these answers and go straight on to propose_courses in this same turn:\n" +
    `- Goal: ${prior.goal || "not stated"}\n` +
    `- Language for the course: ${languageLabel(prior.language)} — write the whole path in it\n` +
    `- Study timetable: ${prior.timetable || "not stated"}`
  );
}

/**
 * Exact prefix the finished intake sends back as a user message. The chat
 * router matches it to force propose_courses, so the client (lib/intake.js)
 * must build the message with exactly this prefix.
 */
export const INTAKE_DONE_PREFIX = "Learning intake complete:";

// ---------------------------------------------------------------------------
// Slot 1 — language
// ---------------------------------------------------------------------------

/**
 * Asked FIRST, before anything else — including the topic questions, which used
 * to be written in a language guessed from the script of the student's request.
 *
 * Four genuinely different languages, never the same one twice: the card used
 * to offer Bangla AND Banglish, which is one language wearing two hats. The
 * question dock renders a free-text box under every card and resolveLanguage
 * honours whatever is typed there, so a fifth language is one keystroke away
 * rather than being silently turned into English.
 */
export const LANGUAGE_QUESTION: AskQuestion = {
  header: "Language",
  question:
    "Which language should your course, lessons and quizzes be written in? " +
    "If yours isn't listed, type it in the box.",
  options: LANGUAGE_OPTIONS,
};

// ---------------------------------------------------------------------------
// Slot 3 — operating system
// ---------------------------------------------------------------------------

/**
 * Asked ONLY when the subject genuinely needs something installed locally
 * (intake plan's `needsLocalSetup`). A course can contain a lesson whose whole
 * job is installing an editor or a runtime, and those are written for ONE
 * operating system — without this the guide has to cover all three and two
 * thirds of it is noise. Asking it of someone studying for an English exam,
 * which is what used to happen, is pure noise.
 */
export const OS_QUESTION: AskQuestion = {
  header: "Your computer",
  question: "Which computer will you be practising on? Setup lessons are written for it specifically.",
  options: ["Windows", "macOS", "Linux"],
};

/**
 * The chosen option (or whatever they typed instead) → the stored enum, or ""
 * when nothing recognisable came back. Free text is expected: "mac", "ubuntu"
 * and "win 11" are all things a student types.
 */
export function parseOperatingSystem(answer: string): "windows" | "macos" | "linux" | "" {
  const a = answer.toLowerCase();
  if (/\b(mac|macos|osx|os x|macbook|imac|apple)\b/.test(a)) return "macos";
  if (/\b(windows|win|win10|win11|pc)\b/.test(a)) return "windows";
  if (/\b(linux|ubuntu|debian|fedora|arch|mint|pop_os|popos|wsl)\b/.test(a)) return "linux";
  return "";
}

// ---------------------------------------------------------------------------
// Slot 4 — editor / IDE
// ---------------------------------------------------------------------------

/**
 * How ready their machine is:
 *   ready   — an editor is installed; no setup lesson needed
 *   none    — no editor yet; the course needs a setup lesson
 *   unknown — they do not know what an editor IS
 *
 * `unknown` is the important one, and it is why the last option is worded the
 * way it is. The requirement was to find out whether the student even
 * understands what an IDE is; making that an ANSWER rather than a second
 * question means one card does the work of two — and it tells the setup lane to
 * explain what an editor is from scratch instead of assuming the words mean
 * anything to them.
 */
export type Tooling = "ready" | "none" | "unknown";

export const TOOLING_ANSWERS = {
  vscode: "Yes — VS Code",
  other: "Yes — a different editor",
  none: "No, nothing installed yet",
  unknown: "I don't know what that is",
} as const;

export const TOOLS_QUESTION: AskQuestion = {
  header: "Your editor",
  question: "Do you have a code editor installed on that computer?",
  options: [
    TOOLING_ANSWERS.vscode,
    TOOLING_ANSWERS.other,
    TOOLING_ANSWERS.none,
    TOOLING_ANSWERS.unknown,
  ],
};

/** Editors a student might name in the free-text box. */
const EDITOR_NAMES =
  /\b(vs ?code|visual studio|vscode|sublime|intellij|pycharm|webstorm|phpstorm|goland|rider|clion|android studio|xcode|eclipse|netbeans|atom|notepad\+\+|neovim|nvim|vim|emacs|cursor|zed|codeblocks|dev ?c\+\+|jupyter|anaconda|spyder|replit)\b/i;

/** "I have no idea what that means", in the languages this app is used in. */
const NO_IDEA =
  /\b(don'?t know|dont know|do not know|no idea|never heard|what is (that|it)|whats that|what'?s that|ki jinish|jani na|janina|bujhi na|bujhina|pata nahi|nahi pata|no se|no sé)\b/i;

const NEGATIVE = /\b(no|not|nope|none|nothing|nai|nei|na\b|nahi|nada)\b/i;

export function parseTooling(answer: string): Tooling {
  const a = answer.trim().toLowerCase();
  if (!a) return "none";
  if (a === TOOLING_ANSWERS.unknown.toLowerCase() || NO_IDEA.test(a)) return "unknown";
  if (a === TOOLING_ANSWERS.vscode.toLowerCase() || a === TOOLING_ANSWERS.other.toLowerCase()) {
    return "ready";
  }
  // Checked before the negative test so "no jetbrains, I use vim" reads right.
  if (EDITOR_NAMES.test(a)) return "ready";
  if (a === TOOLING_ANSWERS.none.toLowerCase() || NEGATIVE.test(a)) return "none";
  if (/\b(yes|yeah|ha|hae|hyan|si|sí)\b/.test(a)) return "ready";
  // Unrecognised free text lands on "none": that costs one setup lesson the
  // student may not need. Landing on "unknown" would instead skip the
  // programming-basics question, which is a much larger inference to make from
  // a sentence we failed to parse.
  return "none";
}

// ---------------------------------------------------------------------------
// Slot 5 — programming foundations
// ---------------------------------------------------------------------------

/**
 * Asked only for programming subjects, and skipped entirely when the editor
 * answer was `unknown` — someone who has never met the word "editor" has
 * already told us they have no programming background, and asking again reads
 * as not listening.
 */
export type Foundation = "none" | "some" | "solid";

export const FOUNDATION_ANSWERS = {
  none: "No — I've never written code",
  some: "A little — I've followed tutorials",
  solid: "Yes — I can write small programs",
  strong: "Yes — I code regularly in another language",
} as const;

export const FOUNDATION_QUESTION: AskQuestion = {
  header: "Programming",
  question: "Do you already understand programming basics — variables, loops, functions?",
  options: [
    FOUNDATION_ANSWERS.none,
    FOUNDATION_ANSWERS.some,
    FOUNDATION_ANSWERS.solid,
    FOUNDATION_ANSWERS.strong,
  ],
};

export function parseFoundation(answer: string): Foundation {
  const a = answer.trim().toLowerCase();
  if (!a) return "none";
  if (a === FOUNDATION_ANSWERS.solid.toLowerCase() || a === FOUNDATION_ANSWERS.strong.toLowerCase()) {
    return "solid";
  }
  if (a === FOUNDATION_ANSWERS.some.toLowerCase()) return "some";
  if (a === FOUNDATION_ANSWERS.none.toLowerCase()) return "none";
  if (/\b(regularly|professional|daily|years?|fluent|comfortable|confident)\b/.test(a)) return "solid";
  if (/\b(little|some|bit|tutorial|basic|learning|shikhchi|thora|kichu)\b/.test(a)) return "some";
  if (NEGATIVE.test(a) || /\b(never|zero|kichu na|kono din na)\b/.test(a)) return "none";
  if (/\b(yes|yeah|ha|hae|hyan|si|sí)\b/.test(a)) return "solid";
  return "some";
}

// ---------------------------------------------------------------------------
// Slot 8 — schedule
// ---------------------------------------------------------------------------

/**
 * Two questions where the old intake asked three.
 *
 * "Finish by" keeps its header because the routine builder reads it. "Daily
 * time" is NEW — nothing in the app captured how long a student can actually
 * sit down for, which is the number that decides whether a 40-lesson course
 * fits in their month. The dropped question was "which days can you study",
 * now assumed to be every day inside the window; the scheduler spreads lessons
 * across it either way.
 *
 * Time of day is NOT asked here — it rides along on the routine question below,
 * where it is only needed if they actually want a routine.
 */
export const SCHEDULE_HEADERS = {
  deadline: "Finish by",
  daily: "Daily time",
} as const;

export const SCHEDULE_QUESTIONS: AskQuestion[] = [
  {
    header: SCHEDULE_HEADERS.deadline,
    question: "How soon do you want to finish this?",
    options: ["Within 1 week", "Within 2 weeks", "Within 1 month", "No rush — 2 months"],
  },
  {
    header: SCHEDULE_HEADERS.daily,
    question: "How much time can you give it on a normal day?",
    options: ["About 30 minutes", "About 1 hour", "About 2 hours", "3 hours or more"],
  },
];

/** Free-text tolerant: "45 min", "1.5 hours", "2 ghonta", "90m" all land. */
export function parseDailyMinutes(answer: string): number {
  const a = answer.trim().toLowerCase();
  const hours = a.match(/(\d+(?:[.,]\d+)?)\s*(hours?|hrs?|h\b|ghonta|ghanta|hora)/);
  if (hours) return Math.round(Number(hours[1]!.replace(",", ".")) * 60);
  const mins = a.match(/(\d+)\s*(minutes?|mins?|m\b|minit)/);
  if (mins) return Number(mins[1]);
  // A bare number is far more often hours than minutes at this scale ("2" means
  // two hours, not two minutes), except when it is big enough to be minutes.
  const bare = a.match(/^(\d+(?:[.,]\d+)?)$/);
  if (bare) {
    const n = Number(bare[1]!.replace(",", "."));
    return n <= 12 ? Math.round(n * 60) : Math.round(n);
  }
  return 60;
}

/** "Within 2 weeks" → 14. Used to size the routine window. */
export function parseFinishByDays(answer: string): number {
  const a = answer.trim().toLowerCase();
  const weeks = a.match(/(\d+)\s*(weeks?|sopta|semana)/);
  if (weeks) return Number(weeks[1]) * 7;
  const months = a.match(/(\d+)\s*(months?|mash|mes)/);
  if (months) return Number(months[1]) * 30;
  const days = a.match(/(\d+)\s*(days?|din|dias?)/);
  if (days) return Number(days[1]);
  if (/month/.test(a)) return 30;
  if (/week/.test(a)) return 7;
  return 30;
}

// ---------------------------------------------------------------------------
// Slot 9 — routine
// ---------------------------------------------------------------------------

/**
 * One card answering two things: whether to build the routine at all, and what
 * time of day to schedule it for.
 *
 * Nothing used to ask the first — the chat agent built a routine after every
 * course whether the student wanted one or not. Folding the clock time into the
 * same answer is what keeps this to a single question: a student who says no
 * never needed to be asked what time they study.
 */
export const ROUTINE_HEADER = "Routine";

export const ROUTINE_ANSWERS = {
  morning: "Yes — mornings (08:00 AM)",
  evening: "Yes — evenings (06:00 PM)",
  night: "Yes — nights (09:00 PM)",
  no: "No — I'll set it up myself later",
} as const;

export const ROUTINE_QUESTION: AskQuestion = {
  header: ROUTINE_HEADER,
  question: "Should I build your day-by-day study routine as soon as the course is ready?",
  options: [
    ROUTINE_ANSWERS.morning,
    ROUTINE_ANSWERS.evening,
    ROUTINE_ANSWERS.night,
    ROUTINE_ANSWERS.no,
  ],
};

export const DEFAULT_ROUTINE_TIME = "06:00 PM";

/** Answer → whether to auto-build, and the clock time to build it at. */
export function parseRoutineChoice(answer: string): { autoRoutine: boolean; routineTime: string } {
  const a = answer.trim().toLowerCase();
  const declined =
    a === ROUTINE_ANSWERS.no.toLowerCase() ||
    (/\b(no|not|later|nope|pore|pore korbo|nai|nahi|despues|después)\b/.test(a) && !/\byes\b/.test(a));
  if (declined) return { autoRoutine: false, routineTime: "" };

  // A typed time wins over the wording ("yes, 7:30 am please").
  const explicit = a.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (explicit) {
    const hour = String(explicit[1]).padStart(2, "0");
    const minute = explicit[2] ?? "00";
    return { autoRoutine: true, routineTime: `${hour}:${minute} ${explicit[3]!.toUpperCase()}` };
  }
  if (/\b(morning|sokal|early|mañana|manana)\b/.test(a)) {
    return { autoRoutine: true, routineTime: "08:00 AM" };
  }
  if (/\b(night|rat|late|noche)\b/.test(a)) return { autoRoutine: true, routineTime: "09:00 PM" };
  if (/\b(afternoon|dupur|tarde)\b/.test(a)) return { autoRoutine: true, routineTime: "02:00 PM" };
  return { autoRoutine: true, routineTime: DEFAULT_ROUTINE_TIME };
}
