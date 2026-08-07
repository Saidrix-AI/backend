import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTINE_TIME,
  parseDailyMinutes,
  parseFinishByDays,
  parseFoundation,
  parseOperatingSystem,
  parseRoutineChoice,
  parseTooling,
} from "../src/agents/tools/prompts/intake.js";
import { guessTopicShape } from "../src/agents/intake/index.js";
import {
  INTAKE_SLOTS,
  nextSlot,
  remainingSlots,
  type IntakeState,
} from "../src/services/intake.slots.js";

// The intake used to ask everybody the same 23 questions. These are the rules
// that cut it to 6-11: which slots apply to whom, and how each answer is read
// back into the fact the next slot branches on.

function stateOf(over: Partial<IntakeState> = {}): IntakeState {
  return {
    topic: "Python",
    objective: "learn python",
    topicKind: "programming",
    needsLocalSetup: true,
    language: "en",
    operatingSystem: "",
    tooling: "",
    foundation: "",
    dailyMinutes: 0,
    finishByDays: 0,
    autoRoutine: false,
    routineTime: "",
    plannedQuestions: {},
    planKnown: true,
    ...over,
  };
}

/** Every slot this student would be asked, start to finish. */
function walkSlots(state: IntakeState, probe: boolean): string[] {
  const seen: string[] = [];
  let key: (typeof INTAKE_SLOTS)[number]["key"] | null = null;
  for (let i = 0; i < INTAKE_SLOTS.length + 1; i++) {
    const { slot } = nextSlot(key, state, probe);
    if (!slot) break;
    seen.push(slot.key);
    key = slot.key;
  }
  return seen;
}

describe("which slots a student is asked", () => {
  it("asks a programming student everything", () => {
    expect(walkSlots(stateOf({ tooling: "ready" }), true)).toEqual([
      "language",
      "goal",
      "os",
      "tools",
      "foundation",
      "background",
      "probe",
      "schedule",
      "routine",
    ]);
  });

  // The complaint this whole redesign started from: someone studying for an
  // English exam was asked which operating system they would practise on.
  it("never asks a non-technical student about their computer or editor", () => {
    const seen = walkSlots(stateOf({ topicKind: "non-technical", needsLocalSetup: false }), false);
    expect(seen).toEqual(["language", "goal", "background", "schedule", "routine"]);
    expect(seen).toHaveLength(5);
  });

  // A cloud/theory subject is technical but needs nothing installed.
  it("skips the setup slots for a technical subject with no local install", () => {
    const seen = walkSlots(stateOf({ topicKind: "technical-tool", needsLocalSetup: false }), false);
    expect(seen).not.toContain("os");
    expect(seen).not.toContain("tools");
    expect(seen).not.toContain("foundation");
  });

  it("does not ask a non-programming subject about programming theory", () => {
    const seen = walkSlots(stateOf({ topicKind: "technical-tool", tooling: "ready" }), false);
    expect(seen).toContain("os");
    expect(seen).toContain("tools");
    expect(seen).not.toContain("foundation");
  });

  // "I don't know what an editor is" already answers "do you know programming
  // basics" — asking anyway reads as not listening.
  it("skips the programming question for someone who does not know what an editor is", () => {
    expect(walkSlots(stateOf({ tooling: "unknown" }), false)).not.toContain("foundation");
    expect(walkSlots(stateOf({ tooling: "none" }), false)).toContain("foundation");
  });

  it("skips the diagnostic when the director says no", () => {
    expect(walkSlots(stateOf({ tooling: "ready" }), false)).not.toContain("probe");
  });
});

describe("progress counting", () => {
  // A total that grows is far worse than one that shortens, so an undecided
  // slot is counted as "will be asked" until it is ruled out.
  it("counts an undecided probe as still coming, then drops it", () => {
    const state = stateOf({ tooling: "ready" });
    expect(remainingSlots("background", state, null).map((s) => s.key)).toContain("probe");
    expect(remainingSlots("background", state, false).map((s) => s.key)).not.toContain("probe");
  });

  // Caught in the first live run: the counter read "1 of 9" on the language
  // card and "2 of 12" on the next one, because the setup slots were being
  // read off their pre-plan defaults instead of being treated as undecided.
  it("counts the plan-dependent slots as still coming before the plan has run", () => {
    const beforePlan = stateOf({ planKnown: false, needsLocalSetup: false, topicKind: "non-technical" });
    const keys = remainingSlots("language", beforePlan, null).map((s) => s.key);
    expect(keys).toContain("os");
    expect(keys).toContain("tools");
    expect(keys).toContain("foundation");
    expect(keys).toHaveLength(9);
  });

  it("never grows once answers start arriving", () => {
    // Worst case for growth: a subject that turns out to need everything.
    const before = remainingSlots("language", stateOf({ planKnown: false }), null).length;
    const after = remainingSlots("language", stateOf({ tooling: "ready" }), true).length;
    expect(after).toBeLessThanOrEqual(before);
  });

  it("shortens as skipped slots are ruled out", () => {
    const technical = remainingSlots("language", stateOf({ tooling: "ready" }), true);
    const plain = remainingSlots(
      "language",
      stateOf({ topicKind: "non-technical", needsLocalSetup: false }),
      false,
    );
    expect(technical.length).toBeGreaterThan(plain.length);
  });
});

describe("reading answers back", () => {
  it("parses the editor answer, including free text", () => {
    expect(parseTooling("Yes — VS Code")).toBe("ready");
    expect(parseTooling("I don't know what that is")).toBe("unknown");
    expect(parseTooling("No, nothing installed yet")).toBe("none");
    // Free text
    expect(parseTooling("i use neovim btw")).toBe("ready");
    expect(parseTooling("pycharm")).toBe("ready");
    expect(parseTooling("editor mane ki? jani na")).toBe("unknown");
    expect(parseTooling("nai")).toBe("none");
    // "no jetbrains, I use vim" must read as ready, not as a negative.
    expect(parseTooling("no jetbrains, I use vim")).toBe("ready");
    // Unparseable falls to "none": one unnecessary setup lesson is a far
    // smaller mistake than wrongly skipping the programming question.
    expect(parseTooling("¯\\_(ツ)_/¯")).toBe("none");
  });

  it("parses the programming-basics answer", () => {
    expect(parseFoundation("No — I've never written code")).toBe("none");
    expect(parseFoundation("A little — I've followed tutorials")).toBe("some");
    expect(parseFoundation("Yes — I can write small programs")).toBe("solid");
    expect(parseFoundation("Yes — I code regularly in another language")).toBe("solid");
    expect(parseFoundation("never")).toBe("none");
    expect(parseFoundation("ektu ektu jani")).toBe("some");
  });

  it("parses the operating system from an option or free text", () => {
    expect(parseOperatingSystem("Windows")).toBe("windows");
    expect(parseOperatingSystem("my macbook")).toBe("macos");
    expect(parseOperatingSystem("ubuntu 24.04")).toBe("linux");
    expect(parseOperatingSystem("a phone")).toBe("");
  });

  // The number nothing in the app captured before this change.
  it("parses daily study time", () => {
    expect(parseDailyMinutes("About 30 minutes")).toBe(30);
    expect(parseDailyMinutes("About 1 hour")).toBe(60);
    expect(parseDailyMinutes("About 2 hours")).toBe(120);
    expect(parseDailyMinutes("3 hours or more")).toBe(180);
    expect(parseDailyMinutes("45 min")).toBe(45);
    expect(parseDailyMinutes("1.5 hours")).toBe(90);
    expect(parseDailyMinutes("2 ghonta")).toBe(120);
    // A bare small number means hours at this scale; a big one means minutes.
    expect(parseDailyMinutes("2")).toBe(120);
    expect(parseDailyMinutes("90")).toBe(90);
    expect(parseDailyMinutes("whenever")).toBe(60);
  });

  it("parses the finish-by window", () => {
    expect(parseFinishByDays("Within 1 week")).toBe(7);
    expect(parseFinishByDays("Within 2 weeks")).toBe(14);
    expect(parseFinishByDays("Within 1 month")).toBe(30);
    expect(parseFinishByDays("No rush — 2 months")).toBe(60);
    expect(parseFinishByDays("10 days")).toBe(10);
    expect(parseFinishByDays("dunno")).toBe(30);
  });

  // One card answering two things: whether to build a routine at all, and when.
  it("parses the routine answer into a decision and a time", () => {
    expect(parseRoutineChoice("Yes — mornings (08:00 AM)")).toEqual({
      autoRoutine: true,
      routineTime: "08:00 AM",
    });
    expect(parseRoutineChoice("Yes — nights (09:00 PM)")).toEqual({
      autoRoutine: true,
      routineTime: "09:00 PM",
    });
    expect(parseRoutineChoice("No — I'll set it up myself later")).toEqual({
      autoRoutine: false,
      routineTime: "",
    });
    // A typed time wins over the wording.
    expect(parseRoutineChoice("yes please, 7:30 am")).toEqual({
      autoRoutine: true,
      routineTime: "07:30 AM",
    });
    expect(parseRoutineChoice("sokal e")).toEqual({ autoRoutine: true, routineTime: "08:00 AM" });
    expect(parseRoutineChoice("pore korbo")).toEqual({ autoRoutine: false, routineTime: "" });
    expect(parseRoutineChoice("sure")).toEqual({
      autoRoutine: true,
      routineTime: DEFAULT_ROUTINE_TIME,
    });
  });
});

// Last resort when the classifier call fails. It must err towards ASKING: a
// wrong "non-technical" denies a Python student their setup lesson, which is
// worse than one extra question.
describe("topic-shape fallback", () => {
  it("recognises programming subjects", () => {
    expect(guessTopicShape("Python for data analysis")).toEqual({
      topicKind: "programming",
      needsLocalSetup: true,
    });
    expect(guessTopicShape("learn react")).toEqual({
      topicKind: "programming",
      needsLocalSetup: true,
    });
  });

  it("recognises tools, and whether they install locally", () => {
    expect(guessTopicShape("Figma for UI design")).toEqual({
      topicKind: "technical-tool",
      needsLocalSetup: false,
    });
    expect(guessTopicShape("Docker basics")).toEqual({
      topicKind: "technical-tool",
      needsLocalSetup: true,
    });
  });

  it("treats everything else as non-technical", () => {
    expect(guessTopicShape("IELTS preparation")).toEqual({
      topicKind: "non-technical",
      needsLocalSetup: false,
    });
    expect(guessTopicShape("digital marketing")).toEqual({
      topicKind: "non-technical",
      needsLocalSetup: false,
    });
  });
});
