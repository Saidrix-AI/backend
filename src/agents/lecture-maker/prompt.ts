import { DEFAULT_LANGUAGE, languageInstruction, type Language } from "../../validation/language.js";
import type { LessonBlueprint, SetupBlueprint } from "./schema.js";

/** Everything the pipeline knows about the lesson being taught. */
export interface LessonContext {
  lessonId: string;
  courseTitle: string;
  courseDesc: string;
  level: "Beginner" | "Intermediate" | "Advanced";
  chapterTitle: string;
  moduleTitle: string;
  topicTitle: string;
  /**
   * The curriculum's instruction for this one lesson (Course-maker `topic.brief`).
   * Falls back to the older one-sentence `topic.summary` for courses generated
   * before the brief existed, and is absent when neither was written.
   */
  topicBrief?: string;
  /** Other topic titles in the same module — the lecture must not re-teach them. */
  siblingTopics: string[];
  /** Inherited from the course, which got it from the guided intake. */
  language?: Language;
  /**
   * Who this lecture is being written for — the background block from
   * services/learnerProfile.service.ts, or absent when nothing is known. The
   * course's `level` fixes how much is assumed; this fixes the register and the
   * examples, so a working engineer and a school student reading the same lesson
   * do not get the same analogies.
   */
  learner?: string;
  /**
   * The student's operating system, from their learner profile (asked in the
   * guided intake). Only the setup lane reads it — an install guide written for
   * three operating systems is two thirds noise for whoever is reading it.
   * Absent when they never answered, which the setup planner handles by
   * covering all three.
   */
  os?: "windows" | "macos" | "linux";
}

/** Display names for the OS, used in prompts and in search queries. */
export const OS_LABELS: Record<NonNullable<LessonContext["os"]>, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

/** The LANGUAGE line every lecture call carries — planner, topic writer and svg alike. */
export function lectureLanguageLine(ctx: Pick<LessonContext, "language">): string {
  return languageInstruction(ctx.language ?? DEFAULT_LANGUAGE);
}

/**
 * The reader block, carried by every call that writes prose the student reads.
 * Returns [] when nothing is known, so callers can spread it unconditionally.
 */
export function lectureLearnerLines(ctx: Pick<LessonContext, "learner">): string[] {
  if (!ctx.learner) return [];
  return [
    "",
    ctx.learner,
    "Pitch the explanations, analogies and examples at this reader. Never address these facts " +
      "directly and never write them into the lecture — they change HOW you teach, not WHAT you teach.",
  ];
}

// --- Lesson analyst ---

export function buildAnalystSystemPrompt(): string {
  return `You are the lesson analyst for Saidrix AI Tutor. You do NOT write or plan the lecture. You READ one lesson's curriculum instruction and work out what it actually has to teach, so the planner and writers that follow you all work from one authoritative reading.

Read the "What this lesson must cover" instruction closely — it, not the lesson title, is the truth about this lesson. The title is a label; the instruction names the real ground.

What each field is for:
- scope: restate in your own words what this lesson teaches. If the instruction is thin, infer what a competent teacher would cover under it at the stated level — but never wander into the sibling lessons.
- objectives: 3-6 things the student can DO afterwards. Concrete and checkable ("trace what a for-loop does on each pass"), never vague ("understand loops").
- assumedKnowledge: what the student already has, so nobody wastes the lecture re-teaching it. Empty is fine for a first lesson.
- concepts: the 3-8 ideas this lesson is made of, ordered EASIEST FIRST, each depending only on the ones before it. This becomes the lecture's spine, so the ordering is the most valuable thing you produce. For each, say why the student should care and what beginners genuinely find hard about it.
- examples: 1-3 CONCRETE worked examples the whole lecture will build. This matters more than it looks: each topic is written later by a separate writer working in parallel, and they can only stay consistent by all citing this one list. So name a real, specific scenario ("totalling a shopping cart with a discount code"), never a placeholder ("an example of a function"). One main example carried through the lecture beats three disconnected ones.
- misconceptions: 2-4 mistakes beginners ACTUALLY make here, and what visibly breaks when they do. Not generic advice.
- visuals: only the ideas a picture genuinely clarifies — see below.
- outOfScope: the neighbouring ground that belongs to the sibling lessons.
- currency: see below — this is how today's reality reaches the writers.

TEACHING WHAT IS CURRENT. A CURRENT INFORMATION block from a live web search run today may appear in your message. You are the ONLY call in this pipeline that sees it: the planner and the topic writers never do. Whatever in it changes how this lesson must be taught, you restate as \`currency\` lines, and whatever you leave out is lost — those writers will fall back on training data that is older than today.

So read it for: the version the student will actually install, syntax or APIs that were renamed or removed, techniques now deprecated and what replaced them, the tool that is now the default. Write each as one flat instruction the writers can act on — "React 19 is current; useEffect data fetching is discouraged, use the framework's data layer or use()" — not as a note about the search. Bake the same facts into \`scope\`, \`concepts\` and \`examples\` too, so the lecture is built on current material from the start rather than corrected at the end.

Only write a \`currency\` line the search actually supports. NEVER invent a version number, release date or "as of" claim to sound current — an invented version is a worse failure than an undated lesson, because the student will type it into a terminal. If there is no block, or nothing in it changes this lesson, return an empty list.

CHOOSING VISUALS — by judgement, not by quota, and not by reflex either way. A picture earns its place when it shows something a sentence cannot: structure, sequence, comparison, transformation, state or relationships. Most technical lessons contain 2-4 such ideas — a mechanism that runs step by step, a structure with parts, two things worth putting side by side, a before/after. Find them and flag them; a lesson taught entirely in prose when its central idea is a process has been under-served.

What you must NOT do is flag one per concept out of habit, or flag a definition, a motivation, a list of rules or a recap. An empty list is the right answer only when the lesson genuinely has no process, structure, comparison or transformation anywhere in it — that is rare, so if you are about to return an empty list, check the concepts once more first.

Pick the kind that fits:
- chart — genuinely NUMERIC comparisons or trends, nothing else.
- tree — a real hierarchy or data structure (BST, DOM tree, file tree, org chart).
- mermaid — the default for everything with flow, process, sequence between parties, state machine, entity or class relationships, or a mind map. Prefer ideas that fit a FLOWCHART: those are the only ones the live tutor can draw for the student one part at a time, which is a real teaching move the other kinds do not get. Do not force a conversation or a state machine into a flowchart to earn it — just prefer it when the idea genuinely fits either.
- svg — ONLY custom spatial ideas no library can express: memory layout, coordinate space, the anatomy of one line of syntax, a before/after transformation of one object. Expensive; flag at most 2-3 and only when nothing above fits.
The planner trusts this list exactly: what you flag gets drawn, what you leave out does not. So padding it produces diagrams that restate the text, and starving it leaves a mechanism the student never sees.

Be specific everywhere. Every sentence you write here is read by another model that cannot ask you follow-up questions.`;
}

export function buildAnalystUserMessage(ctx: LessonContext, grounding = "", freshness = ""): string {
  const lines = [
    lectureLanguageLine(ctx),
    "",
    `Course: ${ctx.courseTitle}${ctx.courseDesc ? ` — ${ctx.courseDesc}` : ""} (Level: ${ctx.level})`,
    `Location: ${ctx.chapterTitle} → ${ctx.moduleTitle}`,
    `Analyse the lesson: "${ctx.topicTitle}"`,
    ...lectureLearnerLines(ctx),
  ];
  if (ctx.topicBrief) {
    lines.push(
      "",
      "What this lesson must cover (from the curriculum — this is the authoritative scope):",
      ctx.topicBrief,
    );
  } else {
    lines.push(
      "",
      "The curriculum left no instruction for this lesson — infer its scope from the lesson title, its position in the course, and the sibling lessons it must not overlap.",
    );
  }
  if (ctx.siblingTopics.length > 0) {
    lines.push("", `Sibling lessons in this module (their ground is OUT of scope here): ${ctx.siblingTopics.join("; ")}`);
  }
  if (grounding) lines.push("", grounding);
  // Last, so the most recently written material is closest to the tool call.
  if (freshness) lines.push("", freshness);
  return lines.join("\n");
}

// --- Blueprint projections ---

/**
 * The analyst's `currency` lines, rendered for the calls that never saw the
 * search results. Shared by the planner and worker projections because both
 * need them stated identically — a planner that plans around React 19 while a
 * writer writes React 17 code produces a lecture that contradicts itself.
 */
function currencyLines(bp: { currency: string[] }): string[] {
  if (bp.currency.length === 0) return [];
  return [
    "",
    "CURRENT AS OF TODAY — established by a live web search and binding on you. Where this " +
      "contradicts what you remember, this is right and your memory is out of date. Teach these " +
      "versions, names and practices; never teach something listed here as deprecated as if it " +
      "were current, and never state a version number that is not on this list:",
    ...bp.currency.map((c) => `- ${c}`),
  ];
}

/**
 * The planner needs the whole reading: the concept spine it turns into an
 * outline, and the visuals list it must follow instead of filling a quota.
 */
export function formatBlueprintForPlanner(bp: LessonBlueprint): string {
  const lines = [
    "LESSON ANALYSIS — this is your authoritative reading of the lesson. Build the lecture from it.",
    "",
    `Scope: ${bp.scope}`,
    "",
    "Objectives (the lecture must deliver every one):",
    ...bp.objectives.map((o) => `- ${o}`),
  ];
  if (bp.assumedKnowledge.length > 0) {
    lines.push("", "Already known — do NOT re-teach:", ...bp.assumedKnowledge.map((a) => `- ${a}`));
  }
  lines.push(
    "",
    "Concepts, easiest first — this is the spine of your outline, one topic each:",
    ...bp.concepts.map((c, i) => {
      const hard = c.hardBecause ? ` Hard because: ${c.hardBecause}` : "";
      return `${i + 1}. ${c.name} — why it matters: ${c.why}.${hard}`;
    }),
  );
  lines.push(
    "",
    "Worked examples — cite one BY NAME in every worked-example brief you write:",
    ...bp.examples.map((e) => `- ${e.name}: ${e.scenario}${e.teaches ? ` (teaches: ${e.teaches})` : ""}`),
  );
  if (bp.misconceptions.length > 0) {
    lines.push(
      "",
      "Mistakes the lecture must warn about — place each in the topic it belongs to:",
      ...bp.misconceptions.map((m) => `- ${m.mistake}${m.whatBreaks ? ` → ${m.whatBreaks}` : ""}`),
    );
  }
  lines.push(
    "",
    bp.visuals.length > 0
      ? "Visuals worth drawing — plan one block for each, of exactly this kind, in the topic that covers that concept. Do NOT invent extras:"
      : "Visuals worth drawing: NONE. This lesson is genuinely verbal — teach it with prose, lists, tables and code. Do not invent diagrams.",
    ...bp.visuals.map((v) => `- [${v.kind}] ${v.concept}: ${v.shows}`),
  );
  if (bp.outOfScope.length > 0) {
    lines.push("", "Out of scope (belongs to sibling lessons):", ...bp.outOfScope.map((o) => `- ${o}`));
  }
  lines.push(...currencyLines(bp));
  return lines.join("\n");
}

/**
 * A topic writer needs far less: its briefs already say what to write. What it
 * cannot get from a brief is what the OTHER writers — running in parallel right
 * now — are doing, which is exactly what breaks the lecture's through-line. So
 * it gets the shared examples, the misconceptions and the objectives, and none
 * of the planning material.
 */
export function formatBlueprintForWorker(bp: LessonBlueprint): string {
  const lines = [
    "Shared lecture context (every topic of this lecture is being written against it):",
    "",
    "Objectives:",
    ...bp.objectives.map((o) => `- ${o}`),
    "",
    "Worked examples — when a brief names one of these, use EXACTLY this scenario:",
    ...bp.examples.map((e) => `- ${e.name}: ${e.scenario}`),
  ];
  if (bp.assumedKnowledge.length > 0) {
    lines.push("", "Already known — do NOT re-teach:", ...bp.assumedKnowledge.map((a) => `- ${a}`));
  }
  if (bp.misconceptions.length > 0) {
    lines.push(
      "",
      "Known beginner mistakes:",
      ...bp.misconceptions.map((m) => `- ${m.mistake}${m.whatBreaks ? ` → ${m.whatBreaks}` : ""}`),
    );
  }
  // The writers produce the code the student will paste into a terminal, so
  // this matters more here than anywhere else in the pipeline.
  lines.push(...currencyLines(bp));
  return lines.join("\n");
}

// --- Lesson classifier ---

export function buildClassifierSystemPrompt(): string {
  return `You sort one lesson of an online course into one of two lecture formats. You respond ONLY by calling emit_lesson_kind exactly once.

"setup" — the lesson exists so that, when it ends, a piece of SOFTWARE IS INSTALLED AND RUNNING on the student's own computer, or an account they need actually exists. Installing an editor or IDE, a language runtime or SDK, a database, a CLI; creating an account and getting an API key; putting something on the PATH; scaffolding a starter project with a tool they just installed.

"concept" — everything else. This is the default and it is by far the more common answer. In particular, a lesson is CONCEPT, not setup, when it:
- teaches how to USE a tool the student already has installed (keyboard shortcuts, the debugger, writing a first program in an editor),
- explains what a tool IS, or compares tools, without installing one,
- teaches a language feature, a technique, a theory or an algorithm — even if the student will type it into a terminal,
- configures something INSIDE a project (a config file, a dependency, an environment variable in code) rather than on the machine.

The test is simple: does this lesson end with the student having pressed "Install" or "Sign up"? If you are not sure, answer "concept" — a concept lesson wrongly routed to setup loses its worked examples and its exam, which is the more damaging mistake.

Judge the LESSON, not the course. A course about setting up a development environment still has concept lessons in it, and a course about JavaScript can contain one setup lesson.

The lesson may be written in any language. Read what it says, not which words it uses.`;
}

export function buildClassifierUserMessage(ctx: LessonContext): string {
  const lines = [
    `Course: ${ctx.courseTitle}${ctx.courseDesc ? ` — ${ctx.courseDesc}` : ""} (Level: ${ctx.level})`,
    `Location: ${ctx.chapterTitle} → ${ctx.moduleTitle}`,
    `Lesson title: "${ctx.topicTitle}"`,
  ];
  if (ctx.topicBrief) {
    lines.push("", "What the curriculum says this lesson must cover:", ctx.topicBrief);
  } else {
    lines.push("", "The curriculum left no description for this lesson — judge it from the title and its position.");
  }
  if (ctx.siblingTopics.length > 0) {
    lines.push("", `The other lessons in this module: ${ctx.siblingTopics.join("; ")}`);
  }
  lines.push("", "Classify this lesson.");
  return lines.join("\n");
}

// --- Setup lane: analyst ---

/** The OS line every setup call carries — or the admission that we don't know. */
export function setupOsLine(ctx: Pick<LessonContext, "os">): string {
  return ctx.os
    ? `THE STUDENT IS ON ${OS_LABELS[ctx.os].toUpperCase()}. Write for that operating system and no other.`
    : "The student's operating system is UNKNOWN, so the guide must cover Windows, macOS and Linux separately.";
}

export function buildSetupAnalystSystemPrompt(): string {
  return `You are the setup analyst for Saidrix AI Tutor. This lesson is not about understanding an idea — it exists so that, when it ends, something is INSTALLED AND RUNNING on the student's own machine. You do NOT write or plan the guide. You work out what actually has to happen, so the planner and writers that follow you all work from one authoritative reading.

What each field is for:
- goal: the state of the student's machine when this lesson ends, stated concretely. "VS Code is installed, the Python extension is active, and running a hello.py file prints to the terminal" — not "the student has set up their environment".
- tools: the 1-2 things genuinely being installed or signed up for (usually the runtime and one editor — this is ONE short beginner class, so nothing optional), named EXACTLY as the vendor names them ("Visual Studio Code", not "VSCode editor"). The download search runs on these names, so a wrong or informal name costs the student their download link. whatItIs is one plain sentence for a beginner; whyThisOne says why this rather than an alternative.
- prerequisites: what must already be true before they start — a supported OS version, free disk space, administrator rights, an existing runtime, an account. For each, the exact way to CHECK it, ideally a command. Leave it empty rather than padding it with the obvious.
- stages: the ordered stages of getting there — typically check prerequisites → download → run the installer → first launch → configure → verify. This becomes the guide's outline, so order it the way the student actually moves.
- verification: how the student PROVES it worked. Give the exact command and the exact expected output ("node -v" → "a version number starting with v"). "Make sure it works" is not a verification.
- pitfalls: the ways this install actually fails, described the way a student would see it — "the installer says the app is from an unidentified developer", "the command is not recognised after installing". Then why, then the fix. Generic advice is worthless here; these become the guide's troubleshooting table and they are the difference between a student who finishes and one who quits.
- visuals: almost always empty. An install is a sequence of screens, and a diagram of "download, then install, then verify" teaches nothing. Flag one mermaid diagram only when several pieces fit together in a way that is genuinely hard to hold in the head.
- outOfScope: what belongs to the sibling lessons — usually "actually using the tool".

WRITE FOR THE STATED OPERATING SYSTEM. The user message tells you which one. Installation differs completely between them, so a blueprint hedged across all three produces a guide that fits nobody. If the OS is unknown, cover all three explicitly and say so in the stages.

TEACHING WHAT IS CURRENT. A CURRENT INFORMATION block from a live web search run today may appear in your message. You are the ONLY call in this pipeline that sees it: the planner and the writers never do. Whatever it establishes about installing this TODAY, you restate as \`currency\` lines, and whatever you leave out is lost.

This matters more here than in any other lesson: the writers' output is commands the student pastes into a terminal, and a version number that is out of date does not read as slightly dated — it fails. So read it for the current version, a download that moved or was renamed, an installer that no longer exists, the package manager that is now the standard way to install this.

NEVER invent a version number, release date or "as of" claim to sound current. If the search does not support it, say nothing about versions and let the guide describe the behaviour instead. An invented version is worse than an undated guide.

Be specific everywhere. Every sentence you write here is read by another model that cannot ask you follow-up questions.`;
}

export function buildSetupAnalystUserMessage(ctx: LessonContext, grounding = "", freshness = ""): string {
  const lines = [
    lectureLanguageLine(ctx),
    "",
    setupOsLine(ctx),
    "",
    `Course: ${ctx.courseTitle}${ctx.courseDesc ? ` — ${ctx.courseDesc}` : ""} (Level: ${ctx.level})`,
    `Location: ${ctx.chapterTitle} → ${ctx.moduleTitle}`,
    `Analyse the setup lesson: "${ctx.topicTitle}"`,
    ...lectureLearnerLines(ctx),
  ];
  if (ctx.topicBrief) {
    lines.push(
      "",
      "What this lesson must cover (from the curriculum — this is the authoritative scope):",
      ctx.topicBrief,
    );
  } else {
    lines.push(
      "",
      "The curriculum left no instruction for this lesson — infer what must be installed from the lesson title, its position in the course, and the sibling lessons it must not overlap.",
    );
  }
  if (ctx.siblingTopics.length > 0) {
    lines.push("", `Sibling lessons in this module (their ground is OUT of scope here): ${ctx.siblingTopics.join("; ")}`);
  }
  if (grounding) lines.push("", grounding);
  // Last, so the most recently written material is closest to the tool call.
  if (freshness) lines.push("", freshness);
  return lines.join("\n");
}

// --- Setup lane: blueprint projections ---

export function formatSetupBlueprintForPlanner(bp: SetupBlueprint): string {
  const lines = [
    "SETUP ANALYSIS — this is your authoritative reading of the lesson. Build the guide from it.",
    "",
    `Goal — what must be true when the student finishes: ${bp.goal}`,
    "",
    "Being installed:",
    ...bp.tools.map((t) => `- ${t.name}: ${t.whatItIs}${t.whyThisOne ? ` (chosen because: ${t.whyThisOne})` : ""}`),
  ];
  if (bp.prerequisites.length > 0) {
    lines.push(
      "",
      "Prerequisites — cover these BEFORE the download:",
      ...bp.prerequisites.map((p) => `- ${p.requirement}${p.howToCheck ? ` → check with: ${p.howToCheck}` : ""}`),
    );
  }
  lines.push(
    "",
    "Stages, in order — this is the spine of your outline, one topic each:",
    ...bp.stages.map((s, i) => `${i + 1}. ${s.name} — ${s.doesWhat}`),
    "",
    "Verification — this becomes the closing checklist, so plan a block for it:",
    ...bp.verification.map((v) => `- ${v.what}${v.command ? ` → run: ${v.command}` : ""} → expect: ${v.expected}`),
    "",
    "How this install goes wrong — this becomes the troubleshooting table:",
    ...bp.pitfalls.map((p) => `- ${p.symptom}${p.cause ? ` (${p.cause})` : ""} → fix: ${p.fix}`),
  );
  lines.push(
    "",
    bp.visuals.length > 0
      ? "Diagrams worth drawing — plan one mermaid block for each, in the topic that covers it. Do NOT invent extras:"
      : "Diagrams worth drawing: NONE. Teach this with prose, numbered lists, commands and callouts.",
    ...bp.visuals.map((v) => `- [${v.kind}] ${v.concept}: ${v.shows}`),
  );
  if (bp.outOfScope.length > 0) {
    lines.push("", "Out of scope (belongs to sibling lessons):", ...bp.outOfScope.map((o) => `- ${o}`));
  }
  lines.push(...currencyLines(bp));
  return lines.join("\n");
}

/**
 * The setup writers get the whole blueprint, unlike the concept lane's writers.
 * A concept writer only needs the shared examples; a setup writer may be the one
 * writing the troubleshooting table or the checklist, and both are built
 * verbatim out of the blueprint's own lists.
 */
export function formatSetupBlueprintForWorker(bp: SetupBlueprint): string {
  const lines = [
    "Shared setup context (every stage of this guide is being written against it):",
    "",
    `Goal: ${bp.goal}`,
    "",
    "Being installed:",
    ...bp.tools.map((t) => `- ${t.name}: ${t.whatItIs}`),
  ];
  if (bp.prerequisites.length > 0) {
    lines.push(
      "",
      "Prerequisites:",
      ...bp.prerequisites.map((p) => `- ${p.requirement}${p.howToCheck ? ` → check with: ${p.howToCheck}` : ""}`),
    );
  }
  lines.push(
    "",
    "Verification — use EXACTLY these commands and expected results:",
    ...bp.verification.map((v) => `- ${v.what}${v.command ? ` → run: ${v.command}` : ""} → expect: ${v.expected}`),
    "",
    "Known failures — the troubleshooting table is built from these:",
    ...bp.pitfalls.map((p) => `- ${p.symptom}${p.cause ? ` (${p.cause})` : ""} → fix: ${p.fix}`),
  );
  // The writers produce the commands the student pastes into a terminal, so
  // this matters more here than anywhere else in the pipeline.
  lines.push(...currencyLines(bp));
  return lines.join("\n");
}
