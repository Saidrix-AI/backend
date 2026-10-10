import type OpenAI from "openai";
import { z } from "zod";
import {
  downloadsBlockSchema,
  easyBlockSchema,
  outlineItemSchema,
  resourcesBlockSchema,
  svgBlockSchema,
  type EasyBlock,
} from "./schema.js";

/**
 * The lecture format (v3) — the only one.
 *
 * A lecture is an outline of topics, and each topic is a run of SECTIONS. A
 * section is one teachable idea and says three things at once:
 *
 *  - `kind` — WHERE it is taught. `theory` is read on the page, `practical` is
 *    typed and run in the Code Lab, `canvas` is drawn on the board.
 *  - `blocks` — what the student SEES: textbook content, no tips, hints or
 *    "remember…" asides. Explaining is the tutor's job, not the page's.
 *  - `tutor` — how the AI tutor teaches it: the points to explain, the analogy,
 *    the mistakes to pre-empt, an optional opening question with its rubric, the
 *    understanding bar, and for practical/canvas the demonstration brief. Never
 *    sent to the student (lecture.service strips it).
 *
 * This replaces both earlier shapes — the flat block list (v1) and blocks plus
 * a separately written beat list (v2). One writer call per topic produces the
 * content and the teaching instructions together, so they cannot drift apart.
 */

export const LECTURE_VERSION = 3;

export const SECTION_KINDS = ["theory", "practical", "canvas"] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

const line = (max: number) => z.string().trim().min(1).max(max);
/** Models send null for an optional field they chose not to fill — read it as absent. */
const opt = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === null ? undefined : v), schema.optional());

/** Block types a section writer may emit. Headings are added by the server; the quiz has its own writer. */
export const WRITER_BLOCK_TYPES = [
  "paragraph",
  "list",
  "code",
  "table",
  "math",
  "mermaid",
  "tree",
  "chart",
  "checklist",
] as const;

const writerBlockSchema = easyBlockSchema.refine(
  (b) => (WRITER_BLOCK_TYPES as readonly string[]).includes(b.type),
  (b) => ({ message: `block type "${b.type}" is not allowed in a section` }),
);

const misconceptionSchema = z.object({
  mistake: line(200),
  whatBreaks: line(240),
  correction: line(320),
});

export const sectionTutorSchema = z.object({
  /** What the student can do after this section. One sentence. */
  goal: line(240),
  /** The explanation as points the tutor speaks in its own words. */
  explain: z.array(line(400)).min(1).max(8),
  /** For a student who already had it roughly right. */
  deeper: z.preprocess((v) => v ?? [], z.array(line(400)).max(6)),
  analogy: opt(z.string().trim().max(320)),
  misconceptions: z.preprocess((v) => v ?? [], z.array(misconceptionSchema).max(4)),
  /** Optional opening question: find out what they already know. */
  ask: opt(z
    .object({
      question: line(240),
      expectedPoints: z.array(line(200)).min(1).max(6),
      worth: z.enum(["ask", "skip"]).catch("skip"),
    })),
  /** The understanding bar — a rubric, not a question. */
  check: z.object({
    mustShow: line(320),
    mode: z.enum(["verbal", "code"]).catch("verbal"),
    weight: z.enum(["key", "light"]).catch("light"),
  }),
  /** practical/canvas: what the demonstration has to make visible. */
  demo: opt(z.string().trim().max(300)),
});
export type SectionTutor = z.infer<typeof sectionTutorSchema>;

/** One section as a writer emits it. ids/topicId are stamped by the server. */
export const sectionEmissionItemSchema = z.object({
  title: line(120),
  kind: z.enum(SECTION_KINDS).catch("theory"),
  blocks: z.array(writerBlockSchema).min(1).max(8),
  tutor: sectionTutorSchema,
});
export type SectionEmissionItem = z.infer<typeof sectionEmissionItemSchema>;

export const sectionEmissionSchema = z.object({
  sections: z.array(sectionEmissionItemSchema).min(1).max(6),
});

const withId = z.object({ id: z.string().min(1) });
/** A block as stored inside a section: any renderable type, with its id. */
export const sectionBlockSchema = z.union([
  easyBlockSchema.and(withId),
  svgBlockSchema.and(withId),
  resourcesBlockSchema.and(withId),
  downloadsBlockSchema.and(withId),
]);

export const sectionSchema = z.object({
  id: line(40),
  topicId: z.number().int().min(1),
  title: line(160),
  kind: z.enum(SECTION_KINDS),
  blocks: z.array(sectionBlockSchema).min(1),
  /** Absent only on server-built sections (quiz, resources, downloads). */
  tutor: sectionTutorSchema.optional(),
});
export type Section = z.infer<typeof sectionSchema>;

/** Whole-document check run after assembly — a failure here is a pipeline bug. */
export const lectureV3Schema = z
  .object({
    title: line(200),
    outline: z.array(outlineItemSchema).min(2).max(17),
    sections: z.array(sectionSchema).min(2).max(80),
  })
  .superRefine((doc, ctx) => {
    const topics = new Set(doc.outline.map((t) => t.id));
    const ids = new Set<string>();
    doc.sections.forEach((s, i) => {
      if (!topics.has(s.topicId)) ctx.addIssue({ code: "custom", path: ["sections", i, "topicId"], message: "unknown topic" });
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["sections", i, "id"], message: "duplicate section id" });
      ids.add(s.id);
    });
  });
export type LectureV3 = z.infer<typeof lectureV3Schema>;

// --- Outline planner ---

export const plannedSectionSchema = z.object({
  title: line(120),
  kind: z.enum(SECTION_KINDS).catch("theory"),
  brief: line(500),
});

export const lectureOutlineSchema = z.object({
  title: line(160),
  topics: z
    .array(
      z.object({
        title: line(120),
        duration: z.string().regex(/^\d+:\d{2}$/).catch("4:00"),
        sections: z.array(plannedSectionSchema).min(1).max(5),
      }),
    )
    .min(2)
    .max(12),
});
export type LectureOutline = z.infer<typeof lectureOutlineSchema>;

const sectionKindDescription =
  "theory = taught on the reading page (explanation, tables, read-only code). practical = the tutor types and RUNS code in the Code Lab while explaining (only for a runnable program; give its language and what running it shows). canvas = the tutor DRAWS it on the whiteboard step by step (a process, structure, flow or comparison).";

export const emitLectureOutlineTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_lecture_outline",
    description: "Emit the lecture's outline: topics, and the sections inside each. Call exactly once.",
    parameters: {
      type: "object",
      required: ["title", "topics"],
      properties: {
        title: { type: "string", description: "The lecture title, in the lecture's language" },
        topics: {
          type: "array",
          minItems: 2,
          maxItems: 12,
          items: {
            type: "object",
            required: ["title", "duration", "sections"],
            properties: {
              title: { type: "string" },
              duration: { type: "string", description: "m:ss estimate for the whole topic" },
              sections: {
                type: "array",
                minItems: 1,
                maxItems: 5,
                items: {
                  type: "object",
                  required: ["title", "kind", "brief"],
                  properties: {
                    title: { type: "string" },
                    kind: { type: "string", enum: [...SECTION_KINDS], description: sectionKindDescription },
                    brief: {
                      type: "string",
                      description:
                        "What this section must teach and show, specific enough for a separate writer: the idea, the worked example by name, and for practical/canvas exactly what is run or drawn.",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

// --- Section writer ---

const blockItemSchema = {
  type: "object",
  required: ["type"],
  description:
    "One content block. Fields by type — paragraph: text. list: items[], style. code: language, code. table: columns[], rows[][]. math: tex, display. mermaid: code, alt. tree: root{name,attributes,children}, alt. chart: chartType, title, data{labels,series[{name,values}]}. checklist: title, checks[{text,command,expected}].",
  properties: {
    type: { type: "string", enum: [...WRITER_BLOCK_TYPES] },
    text: { type: "string" },
    items: { type: "array", items: { type: "string" } },
    style: { type: "string", enum: ["bullet", "numbered"] },
    language: { type: "string" },
    code: { type: "string" },
    columns: { type: "array", items: { type: "string" } },
    rows: { type: "array", items: { type: "array", items: { type: "string" } } },
    tex: { type: "string" },
    display: { type: "boolean" },
    alt: { type: "string" },
    root: { type: "object" },
    orientation: { type: "string", enum: ["vertical", "horizontal"] },
    chartType: { type: "string", enum: ["bar", "line", "pie", "donut"] },
    title: { type: "string" },
    data: { type: "object" },
    checks: {
      type: "array",
      items: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" }, command: { type: "string" }, expected: { type: "string" } },
      },
    },
  },
};

export const emitSectionsTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_sections",
    description: "Write the planned sections of ONE topic: what the student sees, and how the tutor teaches it. Call exactly once.",
    parameters: {
      type: "object",
      required: ["sections"],
      properties: {
        sections: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: {
            type: "object",
            required: ["title", "kind", "blocks", "tutor"],
            properties: {
              title: { type: "string" },
              kind: { type: "string", enum: [...SECTION_KINDS], description: sectionKindDescription },
              blocks: {
                type: "array",
                minItems: 1,
                maxItems: 8,
                items: blockItemSchema,
                description:
                  "What the student reads: professional textbook content. No tips, hints, 'remember', 'pro tip' or suggestion asides — those belong in tutor.explain.",
              },
              tutor: {
                type: "object",
                required: ["goal", "explain", "check"],
                properties: {
                  goal: { type: "string", description: "What the student can DO after this section" },
                  explain: {
                    type: "array",
                    minItems: 1,
                    maxItems: 8,
                    items: { type: "string" },
                    description: "The explanation as POINTS the tutor says in its own words — the why, the intuition, the walkthrough.",
                  },
                  deeper: {
                    type: "array",
                    maxItems: 6,
                    items: { type: "string" },
                    description: "For a student who already knew the basics: what they do NOT know yet.",
                  },
                  analogy: { type: "string" },
                  misconceptions: {
                    type: "array",
                    maxItems: 4,
                    items: {
                      type: "object",
                      required: ["mistake", "whatBreaks", "correction"],
                      properties: {
                        mistake: { type: "string" },
                        whatBreaks: { type: "string" },
                        correction: { type: "string" },
                      },
                    },
                  },
                  ask: {
                    type: "object",
                    required: ["question", "expectedPoints", "worth"],
                    description: "Optional opening question to find out what they already know.",
                    properties: {
                      question: { type: "string" },
                      expectedPoints: { type: "array", items: { type: "string" } },
                      worth: {
                        type: "string",
                        enum: ["ask", "skip"],
                        description: "'ask' only if a learner at this level plausibly knows something about it already.",
                      },
                    },
                  },
                  check: {
                    type: "object",
                    required: ["mustShow", "mode", "weight"],
                    properties: {
                      mustShow: { type: "string", description: "The understanding bar — a rubric, not a question" },
                      mode: { type: "string", enum: ["verbal", "code"] },
                      weight: { type: "string", enum: ["key", "light"] },
                    },
                  },
                  demo: {
                    type: "string",
                    description: "practical/canvas only: what the live demonstration must make visible while it runs or is drawn.",
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

// --- Quiz writer ---

export const quizEmissionSchema = z.object({
  questions: z
    .array(
      z
        .object({
          question: line(400),
          options: z.array(z.string().trim().min(1)).min(2).max(6),
          correctIndex: z.number().int().min(0),
          explanation: z.string().trim().min(1),
          concept: z.string().trim().min(1).optional(),
        })
        .refine((q) => q.correctIndex < q.options.length, { message: "correctIndex out of range" }),
    )
    .min(4)
    .max(10),
});

export const emitQuizTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_quiz",
    description: "Write the lecture's closing exam. Call exactly once.",
    parameters: {
      type: "object",
      required: ["questions"],
      properties: {
        questions: {
          type: "array",
          minItems: 4,
          maxItems: 10,
          items: {
            type: "object",
            required: ["question", "options", "correctIndex", "explanation"],
            properties: {
              question: { type: "string" },
              options: { type: "array", minItems: 2, maxItems: 6, items: { type: "string" } },
              correctIndex: { type: "integer", description: "0-based index of the right option" },
              explanation: { type: "string", description: "Why the right answer is right and the tempting one wrong" },
              concept: { type: "string", description: "Which concept from the list this tests, copied exactly" },
            },
          },
        },
      },
    },
  },
};

export type WriterBlock = EasyBlock;
