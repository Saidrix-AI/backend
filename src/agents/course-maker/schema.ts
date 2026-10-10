import type OpenAI from "openai";
import { z } from "zod";
import { COURSE_ICON_NAMES, LEVELS, THUMBS, type Level } from "../../validation/course.schema.js";
import type { KnowledgeProfile } from "../knowledge-profiler/schema.js";
import type { Language } from "../../validation/language.js";

/** What the chat agent asks the Course-maker to build. */
export interface CourseBrief {
  objective: string;
  level?: Level;
  titleHint?: string;
  seriesContext?: string;
  /**
   * Structured scope boundary for a multi-course path: what earlier courses
   * already cover (prerequisites, don't re-teach) and what later ones will
   * cover (don't pre-empt). Authoritative over `seriesContext` when set —
   * built from the persisted LearningPath (see course-maker-tools.ts).
   */
  pathBoundary?: string;
  /**
   * Compact summary of the student's OTHER courses' coverage (title + chapter
   * titles). Injected so a new course never re-teaches ground the student's
   * existing courses already cover — the universal cross-course dedup, applied
   * whether or not the course is part of a formal path.
   */
  existingCoverage?: string;
  /** Free-text fallback used only when no assessment profile is available. */
  priorKnowledge?: string;
  /** The measured picture from a completed knowledge check, when there is one. */
  profile?: KnowledgeProfile;
  /**
   * The guided intake's brief, on top of `profile`. `profile` says what they
   * know; these say what to DO about it — where chapter 1 begins for this
   * student, what must not be re-taught, whether the course owes them an
   * installation lesson, and how long a sitting they can actually manage.
   * Absent for courses generated outside an intake.
   */
  startFrom?: string;
  skip?: string[];
  needsSetupLesson?: boolean;
  dailyMinutes?: number;
  /**
   * Who the student is — age band, occupation, education, work, interests
   * (services/learnerProfile.service.ts). Orthogonal to `profile`: that measures
   * what they know about THIS topic, this says who is being taught. Empty when
   * they have no learner profile.
   */
  learner?: string;
  /** Content language chosen in the guided intake; defaults to English. */
  language?: Language;
  withProjects: boolean;
}

/*
 * Sanity ceilings, NOT design targets. Nothing in the prompts tells the model to
 * aim for a size — these exist only so a runaway generation can't write a
 * 10,000-lesson document into Mongo. Course size is bounded by the subject, not
 * by any single LLM response: the outline emits chapter briefs (cheap), and each
 * chapter's modules and topics come from its own parallel call.
 */
export const LIMITS = {
  chapters: 60,
  modulesPerChapter: 40,
  topicsPerModule: 40,
  quizzes: 60,
} as const;

/**
 * The outline the LLM emits via `emit_course`: course metadata plus the chapter
 * list, each chapter a title and a brief of what it must cover. No ids
 * (lessonId/quizId are assigned by ids.ts) and no `lessons` (derived by the
 * course service). Cosmetic enums use .catch() so a bad icon/thumb never burns
 * the repair round.
 *
 * Modules and topics are deliberately absent — they come from one expand call
 * per chapter (expand.ts), which is what keeps total course size independent of
 * any one response's token budget.
 */
export const generatedCourseSchema = z.object({
  title: z.string().trim().min(1).max(120),
  desc: z.string().trim().min(1).max(500),
  /**
   * Why this student would take it, and what they can do at the end.
   *
   * Defaulted rather than required: they are the "is this for me?" copy on the
   * course page, and a course whose outline is otherwise perfect must not be
   * lost to a missing paragraph of marketing. Courses generated before these
   * existed simply show `desc`, as they always did.
   */
  whyTake: z.string().trim().max(1200).default(""),
  outcomes: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  level: z.enum(LEVELS),
  estimatedHours: z.number().int().min(1).max(5000),
  // A near-miss like "reactjs" would otherwise put a book icon on a React course
  // with no signal anywhere — log it so the enum's gaps are discoverable.
  icon: z.enum(COURSE_ICON_NAMES).catch((c) => {
    console.warn(`[course-maker] unknown icon ${JSON.stringify(c.input)} → "book"`);
    return "book";
  }),
  thumb: z.enum(THUMBS).catch("dark"),
  chapters: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(160),
        brief: z.string().trim().min(1).max(600),
      }),
    )
    .min(1)
    .max(LIMITS.chapters),
  quizzes: z.array(z.object({ title: z.string().trim().min(1).max(120) })).max(LIMITS.quizzes).default([]),
  /**
   * The course's ONE installation lesson, when the student has no working
   * setup. Inserted by the assembler as the first lesson of chapter 1
   * (`insertSetupLesson`) — never planned as a chapter, because a chapter gets
   * a chapter-sized lesson budget and its writer fills it: that is how a
   * Python course once opened with ten lessons of install, terminal, REPL and
   * virtual environments. Lenient: a malformed one falls back to a default.
   */
  setupLesson: z
    .object({
      title: z.string().trim().min(1).max(160),
      brief: z.string().trim().min(1).max(700),
    })
    .optional()
    .catch(undefined),
});
export type GeneratedCourse = z.infer<typeof generatedCourseSchema>;

/**
 * One fully written chapter: its own modules and topics, with the detail the
 * course page renders. Written by a single expand worker from the chapter's
 * brief — nothing here has to line up with a previously generated outline, so
 * there is no count/order guard to violate.
 */
export const expandedChapterSchema = z.object({
  summary: z.string().trim().min(1).max(600),
  outcomes: z.array(z.string().trim().min(1).max(200)).min(1).max(12),
  estimatedHours: z.number().int().min(0).max(500).catch(0),
  difficulty: z.enum(LEVELS).catch("Beginner"),
  modules: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(160),
        summary: z.string().trim().min(1).max(400),
        topics: z
          .array(
            z.object({
              title: z.string().trim().min(1).max(160),
              summary: z.string().trim().min(1).max(300),
              // The lecture writer's instruction for this one lesson. Required in
              // the tool schema (so the model reliably emits it) but lenient here
              // on purpose: a missing brief degrades to the one-line summary,
              // whereas failing the parse burns the repair round and can cost the
              // whole chapter (expand.ts drops a twice-failed chapter to null).
              brief: z.string().trim().max(700).default(""),
              durationMin: z.number().int().min(1).max(600).catch(15),
            }),
          )
          .min(1)
          .max(LIMITS.topicsPerModule),
      }),
    )
    .min(1)
    .max(LIMITS.modulesPerChapter),
});
export type ExpandedChapter = z.infer<typeof expandedChapterSchema>;

/** The forced function the outline LLM must call (zod above is the enforcement). */
export const emitCourseTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_course",
    description:
      "Emit the course outline: the course metadata and the full ordered chapter list. Call exactly once.",
    parameters: {
      type: "object",
      required: ["title", "desc", "level", "estimatedHours", "icon", "thumb", "chapters", "quizzes"],
      properties: {
        title: { type: "string", description: "Course title, 1-120 characters" },
        desc: { type: "string", description: "1-2 sentence course description, max 500 characters" },
        whyTake: {
          type: "string",
          description:
            "Why THIS student should take this course: the problem it solves for them and what changes once they can do it. 2-4 sentences, addressed to them. Not a restatement of the syllabus and not a restatement of desc — this is the paragraph that answers 'is this for me?'.",
        },
        outcomes: {
          type: "array",
          maxItems: 10,
          items: { type: "string" },
          description:
            "4-8 things they can DO at the end, each starting with a verb — 'Deploy a container to a cloud host', not 'Understanding of containers'. Concrete enough that they could tell whether it is true of them yet.",
        },
        level: { type: "string", enum: [...LEVELS] },
        estimatedHours: { type: "integer", description: "Realistic total study hours for the whole course" },
        icon: { type: "string", enum: [...COURSE_ICON_NAMES], description: "The most topical icon name" },
        thumb: { type: "string", enum: [...THUMBS], description: "Card thumbnail colour" },
        chapters: {
          type: "array",
          description:
            "Every chapter the subject needs, ordered foundational to advanced. Titles and briefs only — the lessons inside each chapter are written afterwards.",
          items: {
            type: "object",
            required: ["title", "brief"],
            properties: {
              title: { type: "string", description: "Chapter title" },
              brief: {
                type: "string",
                description:
                  "2-4 sentences naming the concrete ground this chapter must cover, specific enough that another writer can expand it into lessons without guessing.",
              },
            },
          },
        },
        quizzes: {
          type: "array",
          description: "One checkpoint quiz per chapter",
          items: {
            type: "object",
            required: ["title"],
            properties: { title: { type: "string" } },
          },
        },
        setupLesson: {
          type: "object",
          description:
            "ONLY when you are told the student has no working setup: the ONE short beginner lesson that gets them ready — install the language/runtime and one code editor, then run a first tiny program. It is added as the first lesson of chapter 1. Never plan installation as a chapter or as more lessons.",
          required: ["title", "brief"],
          properties: {
            title: { type: "string", description: "Lesson title, e.g. 'Install Python and VS Code, run your first program'" },
            brief: {
              type: "string",
              description:
                "2-3 sentences for the lecture writer: exactly which runtime and which editor to install, and the first program to run to prove it works. Nothing else — no virtual environments, no terminal tutorial, no settings beyond the defaults.",
            },
          },
        },
      },
    },
  },
};

/** The forced function each expand worker must call, for its one chapter. */
export const emitChapterTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_chapter",
    description:
      "Emit THIS ONE chapter in full: its modules, the lessons inside each module, and the chapter's summary and outcomes. Call exactly once.",
    parameters: {
      type: "object",
      required: ["summary", "outcomes", "estimatedHours", "difficulty", "modules"],
      properties: {
        summary: {
          type: "string",
          description: "2-3 sentences on what this chapter covers and why it matters, max 600 characters",
        },
        outcomes: {
          type: "array",
          description: "Everything the student can DO after this chapter, each starting with a verb",
          items: { type: "string" },
        },
        estimatedHours: { type: "integer", description: "Realistic study hours for this chapter" },
        difficulty: { type: "string", enum: [...LEVELS] },
        modules: {
          type: "array",
          description: "Every module this chapter needs, in teaching order",
          items: {
            type: "object",
            required: ["title", "summary", "topics"],
            properties: {
              title: { type: "string", description: "Module title" },
              summary: { type: "string", description: "One sentence on what this module covers" },
              topics: {
                type: "array",
                description: "Every lesson in this module, in teaching order",
                items: {
                  type: "object",
                  required: ["title", "summary", "brief", "durationMin"],
                  properties: {
                    title: {
                      type: "string",
                      description: "One concrete, teachable lesson title, e.g. 'Variables & Assignment'",
                    },
                    summary: {
                      type: "string",
                      description: "One sentence on what this single lesson teaches, max 300 characters",
                    },
                    brief: {
                      type: "string",
                      description:
                        "Everything this ONE lesson must cover, written for the lecture writer rather than the student: the concepts and terms to introduce, the worked example to build, and the common mistake to warn about. Also name the boundary it must not cross into a sibling lesson. 2-4 sentences, max 700 characters. Never shown to the student.",
                    },
                    durationMin: { type: "integer", description: "Realistic lesson length in minutes" },
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
