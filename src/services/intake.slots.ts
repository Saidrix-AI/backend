import { generateIntakePlan, type TopicKind } from "../agents/intake/index.js";
import {
  FOUNDATION_QUESTION,
  LANGUAGE_QUESTION,
  OS_QUESTION,
  ROUTINE_QUESTION,
  SCHEDULE_QUESTIONS,
  SCHEDULE_HEADERS,
  TOOLS_QUESTION,
  parseDailyMinutes,
  parseFinishByDays,
  parseFoundation,
  parseOperatingSystem,
  parseRoutineChoice,
  parseTooling,
  type Foundation,
  type Tooling,
} from "../agents/tools/prompts/intake.js";
import type { AskQuestion } from "../agents/tools/types.js";
import { retrieveFreshness } from "../agents/shared/freshness.js";
import { formatTemplate, matchCurriculum, toRef, type CurriculumRef } from "../rag/curriculum.js";
import type { IntakeStageName } from "../database/models/learningIntake.model.js";
import {
  isSpeechSupported,
  resolveLanguage,
  suggestLanguages,
  type Language,
  type LanguageEntry,
} from "../validation/language.js";

/**
 * The nine slots of the guided intake, and the rules deciding which of them
 * this particular student is asked.
 *
 * WHY A TABLE. The intake used to be a fixed five-stage sequence ending in a
 * sixteen-question knowledge check — twenty-three questions for everybody,
 * whatever they were learning. Most of them could not apply: the operating
 * system was asked of someone studying for an English exam, eight code
 * diagnostics were fired at people who had never written a line, and round one
 * re-asked the goal the first stage had just collected.
 *
 * Here each slot states its own `applies` predicate, and `interpret` turns the
 * raw answer into a typed fact that later predicates read. That is the whole
 * "check the answer, then decide the next question" rule: it is deterministic
 * and testable for the cheap slots, and delegated to a model only where
 * judgement is genuinely needed (which questions to write, and whether a
 * diagnostic is worth asking at all).
 */

export interface IntakeState {
  topic: string;
  objective: string;
  topicKind: TopicKind;
  needsLocalSetup: boolean;
  language: Language;
  operatingSystem: "windows" | "macos" | "linux" | "";
  tooling: Tooling | "";
  foundation: Foundation | "";
  dailyMinutes: number;
  finishByDays: number;
  autoRoutine: boolean;
  routineTime: string;
  /** Questions the plan call wrote, held until their slot comes up. */
  plannedQuestions: { goal?: AskQuestion; background?: AskQuestion; extra?: AskQuestion[] };
  /** The curriculum template this request matched, or null. */
  curriculum?: CurriculumRef | null;
  /**
   * Whether the intake plan has run yet. Before it has, `topicKind` and
   * `needsLocalSetup` still hold their defaults, so the slots that depend on
   * them cannot be ruled in or out — see remainingSlots.
   */
  planKnown: boolean;
}

/**
 * What one slot's `interpret` hands back to be merged onto the document.
 *
 * `reask` is the exception to that: it is not merged, it means the answer was
 * not usable and the intake should ASK AGAIN rather than move on. The slot
 * table's whole job is "check the answer, then decide the next question" — and
 * until this existed, the second half only ever pointed forwards.
 */
export type StatePatch = Partial<IntakeState> & { reask?: AskQuestion[] };

export interface IntakeSlot {
  key: IntakeStageName;
  label: string;
  /** False → this student is never asked it, and it is recorded as skipped. */
  applies: (s: IntakeState) => boolean;
  /**
   * True when `applies` reads a field the intake plan sets. Such a slot cannot
   * be counted out before the plan has run — see remainingSlots.
   */
  dependsOnPlan?: boolean;
  /**
   * The questions to show. Absent for `probe`, which is not a plain question
   * batch — it runs as a server-scored KnowledgeAssessment and is driven by
   * intake.service directly, the way the old test stage was.
   */
  build?: (s: IntakeState) => AskQuestion[] | Promise<AskQuestion[]>;
  /** The "jachai" step: raw answers → typed facts later slots branch on. */
  interpret?: (answers: string[], s: IntakeState) => StatePatch | Promise<StatePatch>;
}

const first = (answers: string[]) => answers[0]?.trim() ?? "";

/**
 * The language card, asked again because the tutor cannot speak what they chose.
 *
 * Names their language back to them rather than saying "unsupported": someone
 * who typed Nepali has told us something real about themselves, and the
 * suggestions are built from it (Hindi, Bangla, Urdu — not Spanish).
 *
 * The free-text box is still there, so this is not a wall — it is a second
 * attempt with better information, and a student determined to try another
 * language we cannot speak simply lands here again.
 */
function unspeakableLanguageQuestion(chosen: LanguageEntry): AskQuestion {
  return {
    header: "Language",
    question:
      `I can write your course in ${chosen.label}, but I can't yet SPEAK it — and the ` +
      "lessons are taught out loud, so the class itself would be silent. " +
      "Which of these should I use instead?",
    options: suggestLanguages(chosen.code),
  };
}

export const INTAKE_SLOTS: IntakeSlot[] = [
  {
    key: "language",
    label: "Language",
    applies: () => true,
    build: () => [LANGUAGE_QUESTION],
    // Asking this first is what lets everything downstream be written in the
    // right language instead of one guessed from the script the student typed
    // in. The plan call rides along here rather than at intake start, so the
    // first card appears with no LLM call in front of it.
    interpret: async (answers, s) => {
      const chosen = resolveLanguage(first(answers));

      // Checked BEFORE the plan call, which costs a model round-trip: a
      // language we cannot speak is not settled yet, and paying for a plan in
      // it would be paying for an answer we are about to throw away.
      //
      // The course would be perfectly writable in Nepali — it is the CLASS that
      // cannot happen, and the honest moment to say so is here, not when the
      // student opens a classroom and meets silence.
      if (!isSpeechSupported(chosen.code)) {
        return { reask: [unspeakableLanguageQuestion(chosen)] };
      }

      const language = chosen.code;
      const { curriculum, reference } = await intakeReference(s);
      const plan = await generateIntakePlan({
        topic: s.topic,
        objective: s.objective,
        language,
        ...(reference ? { reference } : {}),
      });
      return {
        language,
        topicKind: plan.topicKind,
        needsLocalSetup: plan.needsLocalSetup,
        curriculum,
        plannedQuestions: {
          goal: plan.goalQuestion,
          background: plan.backgroundQuestion,
          extra: plan.extraQuestions,
        },
      };
    },
  },

  {
    key: "goal",
    label: "Goal",
    applies: () => true,
    // The plan's topic-specific extras ride with the goal: same moment, same
    // card, and no new stage for the frontend to know about.
    build: (s) => [s.plannedQuestions.goal ?? FALLBACK_GOAL, ...(s.plannedQuestions.extra ?? [])],
  },

  {
    key: "os",
    label: "Your computer",
    applies: (s) => s.needsLocalSetup,
    dependsOnPlan: true,
    build: () => [OS_QUESTION],
    interpret: (answers) => ({ operatingSystem: parseOperatingSystem(first(answers)) }),
  },

  {
    key: "tools",
    label: "Your editor",
    // Same gate as the OS slot: if the subject needs nothing installed, neither
    // question has an answer worth having.
    applies: (s) => s.needsLocalSetup,
    dependsOnPlan: true,
    build: () => [TOOLS_QUESTION],
    interpret: (answers) => ({ tooling: parseTooling(first(answers)) }),
  },

  {
    key: "foundation",
    label: "Programming",
    // Skipped for anything that is not programming, and skipped for a student
    // who has just said they do not know what a code editor is — they have
    // already answered this, and asking anyway reads as not listening.
    applies: (s) => s.topicKind === "programming" && s.tooling !== "unknown",
    dependsOnPlan: true,
    build: () => [FOUNDATION_QUESTION],
    interpret: (answers) => ({ foundation: parseFoundation(first(answers)) }),
  },

  {
    key: "background",
    label: "Background",
    applies: () => true,
    build: (s) => [s.plannedQuestions.background ?? FALLBACK_BACKGROUND],
  },

  {
    key: "probe",
    label: "Quick check",
    // Set by intake.service from the director's decision — see decideProbe.
    // Never a hard rule: "I know a little" is a judgement call, not a boolean.
    applies: () => true,
  },

  {
    key: "schedule",
    label: "Your schedule",
    applies: () => true,
    build: () => SCHEDULE_QUESTIONS,
    interpret: (answers) => {
      const byHeader = (header: string) =>
        answers[SCHEDULE_QUESTIONS.findIndex((q) => q.header === header)] ?? "";
      return {
        finishByDays: parseFinishByDays(byHeader(SCHEDULE_HEADERS.deadline)),
        dailyMinutes: parseDailyMinutes(byHeader(SCHEDULE_HEADERS.daily)),
      };
    },
  },

  {
    key: "routine",
    label: "Routine",
    applies: () => true,
    build: () => [ROUTINE_QUESTION],
    interpret: (answers) => parseRoutineChoice(first(answers)),
  },
];

/**
 * What the plan writes its questions from: Saidrix's own template for this
 * request when one matches, else a few fresh web results. Never throws — no
 * reference just means the plan writes from the topic alone.
 */
async function intakeReference(
  s: IntakeState,
): Promise<{ curriculum: CurriculumRef | null; reference: string }> {
  const request = `${s.topic}. ${s.objective}`;
  const match = await matchCurriculum(request).catch(() => null);
  if (match) return { curriculum: toRef(match), reference: formatTemplate(match) };
  const fresh = await retrieveFreshness(s.topic, {
    intent: "learning roadmap syllabus tracks",
    maxResults: 3,
    label: "intake",
  }).catch(() => "");
  return { curriculum: null, reference: fresh };
}

/** Used only if the plan call failed AND its own fallback never reached us. */
const FALLBACK_GOAL: AskQuestion = {
  header: "Goal",
  question: "What do you want to be able to do with this?",
  options: ["Get job-ready in it", "Build my own project", "Pass an exam", "Out of interest"],
};

const FALLBACK_BACKGROUND: AskQuestion = {
  header: "Background",
  question: "How much of this have you actually done before?",
  options: ["Nothing at all", "Read a bit, never practised", "Practised a little", "I use it already"],
};

export function slotFor(key: IntakeStageName): IntakeSlot {
  const slot = INTAKE_SLOTS.find((s) => s.key === key);
  if (!slot) throw new Error(`Unknown intake slot: ${key}`);
  return slot;
}

/**
 * The next slot after `key` that this student should actually be asked, plus
 * everything skipped on the way there. `probeDecided` carries the director's
 * answer, which is the one applicability rule that is not a pure function of
 * the state.
 */
export function nextSlot(
  key: IntakeStageName | null,
  state: IntakeState,
  probeDecided: boolean,
): { slot: IntakeSlot | null; skipped: IntakeStageName[] } {
  const from = key === null ? 0 : INTAKE_SLOTS.findIndex((s) => s.key === key) + 1;
  const skipped: IntakeStageName[] = [];
  for (let i = from; i < INTAKE_SLOTS.length; i++) {
    const slot = INTAKE_SLOTS[i]!;
    const applies = slot.key === "probe" ? probeDecided : slot.applies(state);
    if (applies) return { slot, skipped };
    skipped.push(slot.key);
  }
  return { slot: null, skipped };
}

/**
 * Slots this student is still expected to see, counting the current one.
 *
 * Applicability firms up as answers arrive — before the plan call runs we do
 * not know whether the setup slots apply, and before the background answer we
 * do not know about the probe. Undecided slots are counted as WILL be asked, so
 * the total only ever shrinks. A progress counter that grows is far worse than
 * one that shortens: the first live run showed "1 of 9" and then "2 of 12"
 * because the plan-dependent slots were being read off their defaults.
 */
export function remainingSlots(
  currentKey: IntakeStageName,
  state: IntakeState,
  probeDecided: boolean | null,
): IntakeSlot[] {
  const from = INTAKE_SLOTS.findIndex((s) => s.key === currentKey);
  return INTAKE_SLOTS.slice(Math.max(0, from)).filter((slot) => {
    if (slot.key === "probe") return probeDecided ?? true;
    if (slot.dependsOnPlan && !state.planKnown) return true;
    return slot.applies(state);
  });
}

/** How many questions a slot will put on screen — only `schedule` asks two. */
export function questionCountFor(slot: IntakeSlot, state: IntakeState): number {
  if (slot.key === "probe") return 3;
  const built = slot.build?.(state);
  return Array.isArray(built) ? built.length : 1;
}
