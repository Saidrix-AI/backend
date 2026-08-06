import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  classifyCourseIntent,
  forcedToolFor,
  historyHasProposal,
  isRoutineSetupAnswer,
  PROPOSAL_HISTORY_MARKER,
  SELECTION_PREFIX,
  type CourseRoute,
} from "../src/agents/chat-agent/router.js";
import { INTAKE_DONE_PREFIX } from "../src/agents/tools/prompts/intake.js";
import { buildRoutineSetupQuestions } from "../src/agents/tools/prompts/routine.js";

function fakeClient(response: unknown, fail = false) {
  const create = fail
    ? vi.fn().mockRejectedValue(new Error("boom"))
    : vi.fn().mockResolvedValue(response);
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, create };
}

function jsonResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

function route(partial: Partial<CourseRoute> & Pick<CourseRoute, "intent">): CourseRoute {
  return { knowledgeKnown: false, routineReady: false, ...partial };
}

describe("forcedToolFor", () => {
  it("maps routes to the tool to force (with a prior proposal present)", () => {
    const cases: [CourseRoute, string | null][] = [
      [route({ intent: "selection" }), "generate_course"],
      // Every learn request goes through the intake — even a student who has
      // already stated their level still has to choose a content language.
      [route({ intent: "multi", knowledgeKnown: true }), "start_learning_intake"],
      [route({ intent: "multi" }), "start_learning_intake"],
      [route({ intent: "single", knowledgeKnown: true }), "start_learning_intake"],
      [route({ intent: "single" }), "start_learning_intake"],
      [route({ intent: "routine" }), "ask_routine_setup"],
      [route({ intent: "routine", routineReady: true }), "list_courses"],
      [route({ intent: "other", knowledgeKnown: true }), null],
      [route({ intent: "other" }), null],
    ];
    for (const [r, expected] of cases) {
      expect(forcedToolFor(r, true)).toBe(expected);
    }
  });

  it("does NOT force generation for a 'selection' when no proposal exists", () => {
    // "add my courses to my routine" can misclassify as selection — without a
    // real prior proposal this must NOT fabricate a course.
    expect(forcedToolFor(route({ intent: "selection" }), false)).toBeNull();
    expect(forcedToolFor(route({ intent: "selection", knowledgeKnown: true }), false)).toBeNull();
  });

  // A routine request must never reach a course-writing tool — that would
  // create a course the student didn't ask for.
  it("never forces course generation for a routine request", () => {
    for (const ready of [true, false]) {
      const forced = forcedToolFor(route({ intent: "routine", routineReady: ready }), true);
      expect(["generate_course", "propose_courses"]).not.toContain(forced);
    }
  });
});

describe("INTAKE_DONE_PREFIX", () => {
  // The browser hardcodes this string (frontend/src/lib/intake.js) to build the
  // message that makes the chat agent design the path — pin it here so the two
  // sides cannot drift apart silently.
  it("is the exact prefix the finished intake sends", () => {
    expect(INTAKE_DONE_PREFIX).toBe("Learning intake complete:");
    const message = `${INTAKE_DONE_PREFIX}\nGoal: Job\nLanguage: বাংলা (Bangla)`;
    expect(message.startsWith(INTAKE_DONE_PREFIX)).toBe(true);
  });
});

describe("isRoutineSetupAnswer", () => {
  it("matches the message the routine setup cards compile", () => {
    const answers = buildRoutineSetupQuestions(["Python Basics", "React"])
      .map((q) => `${q.header}: ${q.options[0]}`)
      .join("\n");
    expect(isRoutineSetupAnswer(answers)).toBe(true);
    // The course question is dropped when only one course exists — still a match.
    const single = buildRoutineSetupQuestions(["Python Basics"], "Python Basics")
      .map((q) => `${q.header}: ${q.options[0]}`)
      .join("\n");
    expect(isRoutineSetupAnswer(single)).toBe(true);
  });

  it("ignores ordinary messages", () => {
    expect(isRoutineSetupAnswer("banao amar routine")).toBe(false);
    expect(isRoutineSetupAnswer("Course: Python Basics")).toBe(false);
    expect(isRoutineSetupAnswer("")).toBe(false);
  });
});

describe("historyHasProposal", () => {
  it("detects a re-injected proposal in assistant history", () => {
    expect(historyHasProposal([])).toBe(false);
    expect(
      historyHasProposal([{ role: "user", content: `${PROPOSAL_HISTORY_MARKER} 1. "X"]` }]),
    ).toBe(false); // only assistant turns count
    expect(
      historyHasProposal([
        { role: "user", content: "become a data scientist" },
        { role: "assistant", content: `Pick some!\n\n${PROPOSAL_HISTORY_MARKER}\n1. "Python"]` },
      ]),
    ).toBe(true);
  });
});

describe("SELECTION_PREFIX", () => {
  it("matches the message the proposal-cards button sends", () => {
    const titles = ["Python Foundations", "Intro to ML"];
    const buttonMessage = `Create these courses: ${titles.map((t) => `"${t}"`).join(", ")}`;
    expect(buttonMessage.startsWith(SELECTION_PREFIX)).toBe(true);
  });
});

describe("classifyCourseIntent", () => {
  it("parses a valid classification", async () => {
    const { client, create } = fakeClient(
      jsonResponse('{"intent":"multi","knowledge_known":true}'),
    );
    const classified = await classifyCourseIntent(
      client,
      "fake/model",
      [],
      "ami data scientist hote chai",
    );
    expect(classified).toEqual({ intent: "multi", knowledgeKnown: true, routineReady: false });

    const req = create.mock.calls[0]![0] as { messages: { role: string; content: string }[] };
    expect(req.messages.at(-1)?.content).toContain("ami data scientist hote chai");
  });

  it("includes recent history in the transcript", async () => {
    const { client, create } = fakeClient(
      jsonResponse('{"intent":"selection","knowledge_known":true}'),
    );
    await classifyCourseIntent(
      client,
      "fake/model",
      [
        { role: "user", content: "ami data scientist hote chai" },
        { role: "assistant", content: "Pick from the cards!" },
      ],
      "prothom ta banao",
    );
    const req = create.mock.calls[0]![0] as { messages: { role: string; content: string }[] };
    expect(req.messages.at(-1)?.content).toContain("student: ami data scientist hote chai");
    expect(req.messages.at(-1)?.content).toContain("assistant: Pick from the cards!");
  });

  it("parses a routine turn that already has its setup answers", async () => {
    const { client } = fakeClient(
      jsonResponse('{"intent":"routine","knowledge_known":false,"routine_ready":true}'),
    );
    const classified = await classifyCourseIntent(client, "fake/model", [], "Study time: Night");
    expect(classified).toEqual({ intent: "routine", knowledgeKnown: false, routineReady: true });
  });

  it("returns null on malformed JSON, unknown intent, or client failure", async () => {
    const malformed = fakeClient(jsonResponse("not json"));
    expect(await classifyCourseIntent(malformed.client, "m", [], "x")).toBeNull();

    const unknown = fakeClient(jsonResponse('{"intent":"banana","knowledge_known":true}'));
    expect(await classifyCourseIntent(unknown.client, "m", [], "x")).toBeNull();

    const failing = fakeClient(null, true);
    expect(await classifyCourseIntent(failing.client, "m", [], "x")).toBeNull();
  });
});
