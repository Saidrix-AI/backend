import { describe, expect, it } from "vitest";
import { fakeDeps, fakeRoutingDeps, toolCallResponse } from "./helpers/fakeLlm.js";
import { makeLecture } from "../src/agents/lecture-maker/index.js";
import type { LessonContext } from "../src/agents/lecture-maker/prompt.js";
import { lectureV3Schema, sectionEmissionSchema } from "../src/agents/lecture-maker/sections.js";
import { findQuiz, toLectureJson, type StoredSection } from "../src/services/lectureProjection.js";

const CTX: LessonContext = {
  lessonId: "py-abcd-c1m1t1",
  courseTitle: "Python Basics",
  courseDesc: "Learn Python from scratch.",
  level: "Beginner",
  chapterTitle: "Foundations",
  moduleTitle: "Control Flow",
  topicTitle: "Loops",
  topicBrief: "Introduce for and while loops.",
  siblingTopics: ["Conditionals"],
};

const BLUEPRINT = {
  scope: "How loops repeat work.",
  objectives: ["Trace a for loop", "Choose for vs while"],
  assumedKnowledge: [],
  concepts: [
    { name: "for loops", why: "Repeat over a sequence", hardBecause: "range end is exclusive" },
    { name: "while loops", why: "Repeat until a condition", hardBecause: "infinite loops" },
  ],
  examples: [{ name: "cart-total", scenario: "Totalling a shopping cart", teaches: "for loops" }],
  misconceptions: [{ mistake: "range(5) includes 5", whatBreaks: "Off-by-one" }],
  visuals: [],
  outOfScope: ["Conditionals"],
};

const OUTLINE = {
  title: "Loops in Python",
  topics: [
    {
      title: "Repeating with for",
      duration: "6:00",
      sections: [
        { title: "What a for loop does", kind: "theory", brief: "Explain iteration over a list" },
        { title: "Totalling the cart", kind: "practical", brief: "Python program that sums cart prices and prints the total" },
      ],
    },
    {
      title: "Repeating with while",
      duration: "5:00",
      sections: [{ title: "The loop's flow", kind: "canvas", brief: "Draw condition → body → back to condition" }],
    },
  ],
};

const tutor = (goal: string) => ({
  goal,
  explain: ["Point one", "Point two"],
  check: { mustShow: "Can trace it", mode: "verbal", weight: "key" },
});

const TOPIC1 = {
  sections: [
    { title: "x", kind: "theory", blocks: [{ type: "paragraph", text: "A for loop visits each item." }], tutor: tutor("Trace a for loop") },
    {
      title: "y",
      kind: "theory", // writer drifts — the plan's kind must win
      blocks: [{ type: "code", code: "total = 0\nfor p in [3, 4]:\n    total += p\nprint(total)" }],
      tutor: { ...tutor("Sum a cart"), demo: "Watch total grow each pass" },
    },
  ],
};
const TOPIC2 = {
  sections: [
    {
      title: "z",
      kind: "canvas",
      blocks: [{ type: "tree", root: { name: "condition", children: [{ name: "body" }] }, alt: "while flow" }],
      tutor: tutor("Draw the while flow"),
    },
  ],
};
const QUIZ = {
  questions: Array.from({ length: 4 }, (_, i) => ({
    question: `Q${i}`,
    options: ["a", "b"],
    correctIndex: 1,
    explanation: "because",
    concept: "for loops",
  })),
};

function deps(kind: "concept" | "setup" = "concept") {
  return {
    classifier: fakeDeps(toolCallResponse("emit_lesson_kind", { kind, reason: "r" })).deps,
    analyst: fakeDeps(toolCallResponse("emit_lesson_blueprint", BLUEPRINT)).deps,
    planner: fakeDeps(toolCallResponse("emit_lecture_outline", OUTLINE)).deps,
    worker: fakeRoutingDeps((text) => {
      if (text.includes("closing exam")) return toolCallResponse("emit_quiz", QUIZ);
      return text.includes("Topic 2:")
        ? toolCallResponse("emit_sections", TOPIC2)
        : toolCallResponse("emit_sections", TOPIC1);
    }).deps,
  };
}

describe("lecture v3 pipeline", () => {
  it("assembles sections with server ids, planned titles/kinds, and a closing quiz", async () => {
    const made = await makeLecture(CTX, deps());
    expect(lectureV3Schema.safeParse(made).success).toBe(true);
    expect(made.sections.map((s) => [s.id, s.kind, s.title])).toEqual([
      ["s1", "theory", "What a for loop does"],
      ["s2", "practical", "Totalling the cart"],
      ["s3", "canvas", "The loop's flow"],
      ["s4", "theory", "Check your understanding"],
    ]);
    expect(made.sections.flatMap((s) => s.blocks.map((b) => b.id))).toEqual(["b1", "b2", "b3", "b4"]);
    const code = made.sections[1]!.blocks[0] as { language?: string; sectionId?: string };
    expect(code.language).toBe("python"); // backfilled from the brief
    expect(code.sectionId).toBe("s2");
    expect(made.sections[3]!.blocks[0]!.type).toBe("quiz");
  });

  it("rejects callout and other filler blocks from a writer", () => {
    const bad = sectionEmissionSchema.safeParse({
      sections: [{ title: "t", kind: "theory", blocks: [{ type: "callout", text: "Pro tip!" }], tutor: tutor("g") }],
    });
    expect(bad.success).toBe(false);
  });
});

describe("lecture projection", () => {
  const sections: StoredSection[] = [
    {
      id: "s1",
      topicId: 1,
      title: "Totalling the cart",
      kind: "practical",
      blocks: [{ id: "b1", type: "code", code: "print(1)" }],
      tutor: { goal: "Sum a cart", explain: ["p"], check: { mustShow: "m" }, demo: "watch it" },
    },
    {
      id: "s2",
      topicId: 1,
      title: "Quiz",
      kind: "theory",
      blocks: [{ id: "b2", type: "quiz", questions: [{ question: "q", options: ["a", "b"], correctIndex: 1, explanation: "e" }] }],
    },
  ];
  const doc = { lessonId: "L", version: 3, title: "T", outline: [], sections };

  it("never gives the student tutor instructions or the quiz key", () => {
    const json = toLectureJson(doc, "student");
    expect(JSON.stringify(json)).not.toContain("Sum a cart");
    expect(JSON.stringify(json)).not.toContain("correctIndex");
    expect(json.beats).toEqual([{ id: "s1", topicId: 1, concept: "Totalling the cart", kind: "practical" }]);
    expect(json.blocks.map((b) => b.beatId)).toEqual(["s1", "s2"]);
  });

  it("gives the tutor a beat per taught section with its demo block", () => {
    const json = toLectureJson(doc, "tutor");
    const beat = json.beats[0] as unknown as { demo: unknown; teach: { plain: { points: string[] } }; demoBrief: string };
    expect(beat.demo).toEqual({ kind: "code", blockId: "b1" });
    expect(beat.demoBrief).toBe("watch it");
    expect(beat.teach.plain.points).toEqual(["p"]);
    expect(JSON.stringify(json)).not.toContain("correctIndex");
    expect(findQuiz(doc)?.[0]?.correctIndex).toBe(1);
  });
});
