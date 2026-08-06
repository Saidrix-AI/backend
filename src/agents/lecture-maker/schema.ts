import type OpenAI from "openai";
import { z } from "zod";
import { ICON_NAMES } from "../../validation/course.schema.js";

/**
 * Lecture block contract (generation subset): every block type from
 * docs/lecture.schema.json EXCEPT `image` (never generated — visuals are
 * svg/diagram/chart by design) and EXCEPT `interactive` (the step-through /
 * flip-cards / slider-value widgets were removed: their rendering was
 * unreliable, and an LLM-drawn svg teaches the same idea more clearly).
 * Cosmetic enums use .catch() so a bad tone/icon/shape never burns the repair
 * round; meaning-bearing fields stay strict.
 */

/**
 * Colour names a chart/diagram block may request. These resolve to the diagram
 * palette in frontend/src/components/blocks/colorTokens.js — validated for
 * colour-blind separation and contrast, unlike the app's --accent-* chrome.
 * `indigo` is retained only so lectures cached before the change still render.
 */
export const COLOR_TOKENS = [
  "blue", "teal", "amber", "purple", "red", "green", "dark", "muted", "indigo",
] as const;
/**
 * Lecture callouts and diagram nodes use the GENERIC glyphs only — re-exported
 * from the course contract rather than redeclared, which is what let this list
 * silently drift four names behind. Brand marks are deliberately excluded: they
 * carry their own colours and would fight a callout's tone colour.
 */
export { ICON_NAMES };

const baseBlockFields = {
  topicId: z.number().int().optional(),
  caption: z.string().optional(),
  sideText: z.string().optional(),
};

const headingBlockSchema = z.object({
  type: z.literal("heading"),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]).catch(3).optional(),
  text: z.string().trim().min(1),
  ...baseBlockFields,
});

const paragraphBlockSchema = z.object({
  type: z.literal("paragraph"),
  text: z.string().trim().min(1),
  muted: z.boolean().optional(),
  ...baseBlockFields,
});

const listBlockSchema = z.object({
  type: z.literal("list"),
  style: z.enum(["bullet", "numbered"]).catch("bullet").optional(),
  items: z.array(z.string().trim().min(1)).min(1).max(12),
  ...baseBlockFields,
});

const calloutBlockSchema = z.object({
  type: z.literal("callout"),
  text: z.string().trim().min(1),
  tone: z.enum(["info", "success", "warning"]).catch("info").optional(),
  icon: z.enum(ICON_NAMES).catch("info").optional(),
  ...baseBlockFields,
});

const codeBlockSchema = z.object({
  type: z.literal("code"),
  language: z.string().optional(),
  code: z.string().min(1),
  ...baseBlockFields,
});

const chartBlockSchema = z.object({
  type: z.literal("chart"),
  chartType: z.enum(["bar", "line", "pie", "donut"]),
  title: z.string().optional(),
  data: z.object({
    labels: z.array(z.string().min(1)).min(1).max(12),
    series: z
      .array(
        z.object({
          name: z.string().min(1),
          values: z.array(z.number()).min(1),
          color: z.enum(COLOR_TOKENS).catch("blue").optional(),
        }),
      )
      .min(1)
      .max(5),
  }),
  ...baseBlockFields,
});

const diagramNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  sublabel: z.string().optional(),
  tag: z.string().optional(),
  icon: z.enum(ICON_NAMES).catch("info").optional(),
  color: z.enum(COLOR_TOKENS).catch("blue").optional(),
  shape: z.enum(["box", "iconBox", "circle", "pill"]).catch("iconBox").optional(),
});

const diagramBlockSchema = z.object({
  type: z.literal("diagram"),
  layout: z.enum(["flow", "tree", "cycle", "timeline", "grid"]),
  direction: z.enum(["horizontal", "vertical"]).catch("horizontal").optional(),
  nodes: z.array(diagramNodeSchema).min(1).max(9),
  edges: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        label: z.string().optional(),
        style: z.enum(["solid", "dashed"]).catch("solid").optional(),
      }),
    )
    .optional(),
  ...baseBlockFields,
});

/**
 * Mermaid diagram. The model writes the Mermaid DSL as text and the library lays
 * it out itself in the browser — so this replaces most hand-drawn svg at a
 * fraction of the cost, and there is no coordinate arithmetic for the model to
 * get wrong (the overlap/clipping defect can't happen). Validated by parsing the
 * code in a real Mermaid instance (agents/lecture-maker/mermaid.ts), not here.
 * `alt` carries the narration/accessibility text the diagram's own labels don't.
 */
const mermaidBlockSchema = z.object({
  type: z.literal("mermaid"),
  code: z.string().trim().min(5),
  alt: z.string().trim().min(1),
  ...baseBlockFields,
});

/**
 * A hierarchy for react-d3-tree: data structures (BST, DOM tree, file tree) that
 * Mermaid draws less cleanly. The model supplies only the shape; the library
 * computes every position, so again no coordinates are authored by hand.
 * Depth/breadth are bounded so a runaway tree can't produce an unreadable wall.
 */
type TreeNodeInput = {
  name: string;
  attributes?: Record<string, string>;
  children?: TreeNodeInput[];
};
const treeNodeSchema: z.ZodType<TreeNodeInput> = z.lazy(() =>
  z.object({
    name: z.string().trim().min(1),
    attributes: z.record(z.string()).optional(),
    children: z.array(treeNodeSchema).max(8).optional(),
  }),
);
const treeBlockSchema = z.object({
  type: z.literal("tree"),
  root: treeNodeSchema,
  orientation: z.enum(["vertical", "horizontal"]).catch("vertical").optional(),
  alt: z.string().trim().min(1),
  ...baseBlockFields,
});

// A React Flow `flow` block was prototyped here but deferred: @xyflow/react 12
// does not render edges under this app's React 19.2 / Vite 8 stack (even the
// minimal two-node example draws nodes but no edges), and Mermaid already covers
// flowcharts and graphs reliably. Revisit if the stack or library moves on.

/**
 * A data table (TanStack Table on the client). Content, not a "visual" — it does
 * not satisfy the every-topic-needs-a-picture rule, same as list/code. Rows are
 * arrays of cell strings aligned to `columns`; the frontend tolerates ragged
 * rows but the model is told to keep them square.
 */
const tableBlockSchema = z.object({
  type: z.literal("table"),
  columns: z.array(z.string().trim().min(1)).min(1).max(6),
  rows: z.array(z.array(z.string()).min(1)).min(1).max(20),
  ...baseBlockFields,
});

/**
 * A mathematical expression (KaTeX on the client). `display` true renders it
 * centred on its own line; false renders it inline-sized. `tex` is raw LaTeX
 * math, no surrounding $..$.
 */
const mathBlockSchema = z.object({
  type: z.literal("math"),
  tex: z.string().trim().min(1),
  display: z.boolean().optional(),
  ...baseBlockFields,
});

/**
 * The setup lane's closing block: "tick these off and your machine is ready".
 *
 * It replaces the quiz there — a multiple-choice exam on an install guide tests
 * reading comprehension, not whether the tool actually runs. `command` and
 * `expected` are what make an item checkable rather than a vague reassurance:
 * the student runs the line and compares the output.
 *
 * The array is `checks`, not `items`, because `list` already owns `items` in the
 * flat block object the worker tool describes, and two different shapes under
 * one property name is the fastest way to make a model emit the wrong one.
 */
const checklistBlockSchema = z.object({
  type: z.literal("checklist"),
  title: z.string().optional(),
  checks: z
    .array(
      z.object({
        text: z.string().trim().min(1),
        command: z.string().trim().min(1).optional(),
        expected: z.string().trim().min(1).optional(),
      }),
    )
    .min(2)
    .max(10),
  ...baseBlockFields,
});

const quizQuestionSchema = z
  .object({
    question: z.string().trim().min(1),
    options: z.array(z.string().min(1)).min(2),
    correctIndex: z.number().int().min(0),
    explanation: z.string().optional(),
    /**
     * Which concept from the analyst's brief this question tests. Server-only:
     * lecture.service strips it alongside correctIndex, because naming the
     * concept beside a question is a strong hint at its answer. It is what lets
     * a graded exam move that concept between the student's known and gap
     * lists. Optional so lectures cached before tagging still validate.
     */
    concept: z.string().trim().min(1).optional(),
  })
  .refine((q) => q.correctIndex < q.options.length, { message: "correctIndex out of range" });

/**
 * The lecture's single assessment. Per-topic checkpoint quizzes were removed —
 * one dedicated quiz closes the lecture instead — so the cap is higher than the
 * old per-topic one: this block now has to cover every outline topic.
 */
const quizBlockSchema = z.object({
  type: z.literal("quiz"),
  title: z.string().optional(),
  questions: z.array(quizQuestionSchema).min(1).max(10),
  ...baseBlockFields,
});

/**
 * Discriminated on `type`, not a plain union: a plain union reports every
 * rejection as a bare "blocks.0: Invalid input", which is what the worker hands
 * back as repair feedback — telling the model nothing about what to fix, and
 * costing lectures that then fail their second attempt too. Discriminating on
 * the type gives the real reason ("items: array must contain at least 1
 * element"), which a model can actually act on.
 */
export const easyBlockSchema = z.discriminatedUnion("type", [
  headingBlockSchema,
  paragraphBlockSchema,
  listBlockSchema,
  calloutBlockSchema,
  codeBlockSchema,
  chartBlockSchema,
  diagramBlockSchema,
  mermaidBlockSchema,
  treeBlockSchema,
  tableBlockSchema,
  mathBlockSchema,
  quizBlockSchema,
  checklistBlockSchema,
]);
export type EasyBlock = z.infer<typeof easyBlockSchema>;

/** The svg block as assembled (markup produced by the svg worker). */
export const svgBlockSchema = z.object({
  type: z.literal("svg"),
  svg: z.string().min(20),
  alt: z.string().trim().min(1),
  width: z.number().optional(),
  ...baseBlockFields,
});

/**
 * The lecture's closing "where to go next" list.
 *
 * Deliberately absent from `easyBlockSchema` and `BLOCK_PLAN_TYPES`: no planner
 * and no topic writer may emit one. Every link here is copied out of a live
 * search result by agents/lecture-maker/resources.ts, and a model is only ever
 * allowed to pick candidates by index — so an invented URL, which the student
 * would click and land on a 404, is impossible by construction rather than by
 * instruction. This union is the only place the type is accepted.
 */
export const RESOURCE_KINDS = ["doc", "article", "video"] as const;

const resourceLinkSchema = z.object({
  kind: z.enum(RESOURCE_KINDS),
  title: z.string().trim().min(1).max(140),
  /** Never model-authored: copied from the search result our own code holds. */
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "http(s) only"),
  /** Display badge, derived server-side from `url`. */
  domain: z.string().trim().min(1),
  why: z.string().trim().min(1).max(220),
});

export const resourcesBlockSchema = z
  .object({
    type: z.literal("resources"),
    /**
     * Spoken verbatim by the voice engine and shown as the standfirst. Written
     * at build time rather than by the narrator, because a narrator handed this
     * block reads the URLs out loud letter by letter.
     */
    intro: z.string().trim().min(1).max(400),
    links: z.array(resourceLinkSchema).min(1).max(6),
    ...baseBlockFields,
  })
  .refine((b) => b.links.filter((l) => l.kind === "video").length <= 1, {
    message: "at most one video",
  });
export type ResourcesBlock = z.infer<typeof resourcesBlockSchema>;

/**
 * Where the student actually gets the software — the setup lane's counterpart to
 * `resources`, and absent from `easyBlockSchema` for the same reason: every url
 * here is copied out of a live search result by lecture-maker/downloads.ts, and
 * `emit_download_picks` has no url property at all. This matters more than it
 * does for further reading — a wrong further-reading link is a 404, a wrong
 * download link is an installer the student runs with admin rights.
 *
 * Unlike `resources` this block sits in the MIDDLE of the lecture (the planner
 * places it, before the install steps), so it is a plan entry consumed at
 * assembly the way an svg entry is, not something appended at the end.
 */
export const DOWNLOAD_KINDS = ["installer", "page", "docs"] as const;
export const DOWNLOAD_OS = ["windows", "macos", "linux", "any"] as const;

const downloadLinkSchema = z.object({
  kind: z.enum(DOWNLOAD_KINDS),
  /** What to click, e.g. "Visual Studio Code — Windows x64 installer". */
  label: z.string().trim().min(1).max(140),
  /** Never model-authored: copied from the search result our own code holds. */
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "http(s) only"),
  /** Display badge, derived server-side from `url`. */
  domain: z.string().trim().min(1),
  note: z.string().trim().min(1).max(220),
});

export const downloadsBlockSchema = z.object({
  type: z.literal("downloads"),
  /** Spoken verbatim by the voice engine — written at build time, no urls in it. */
  intro: z.string().trim().min(1).max(400),
  os: z.enum(DOWNLOAD_OS).catch("any"),
  links: z.array(downloadLinkSchema).min(1).max(4),
  ...baseBlockFields,
});
export type DownloadsBlock = z.infer<typeof downloadsBlockSchema>;

const withId = z.object({ id: z.string().min(1) });
export const finalBlockSchema = z.union([
  easyBlockSchema.and(withId),
  svgBlockSchema.and(withId),
  resourcesBlockSchema.and(withId),
  downloadsBlockSchema.and(withId),
]);

export const outlineItemSchema = z.object({
  id: z.number().int().min(1),
  title: z.string().trim().min(1),
  duration: z.string().regex(/^\d+:\d{2}$/),
});
export type OutlineItem = z.infer<typeof outlineItemSchema>;

/**
 * Whole-document check run after assembly — failure means a pipeline bug.
 *
 * 17 outline topics, not 16: the PLANNER is still capped at 16
 * (`lecturePlanSchema`), and the resources step appends one more topic after
 * the plan has been executed. Leaving both at 16 would make a 16-topic lecture
 * fail here — turning the one step that must never sink a lecture into the only
 * thing that could.
 */
export const assembledLectureSchema = z.object({
  title: z.string().trim().min(1),
  outline: z.array(outlineItemSchema).min(2).max(17),
  blocks: z.array(finalBlockSchema).min(1),
});

// --- Lesson blueprint (analyst output) ---

/**
 * What the analyst understood about this lesson before anything is planned.
 *
 * The planner used to comprehend the lesson, decide the pedagogy AND emit 20-60
 * briefs in one call, which on a cheap model meant the outline tracked the topic
 * *title* rather than the curriculum's `topic.brief`. Splitting comprehension
 * out gives every later call one authoritative reading of the lesson — and, just
 * as importantly, ONE list of worked examples, so the N topic writers running in
 * parallel build the same running example instead of N unrelated ones.
 */
export const VISUAL_KINDS = ["mermaid", "tree", "chart", "svg"] as const;

export const lessonBlueprintSchema = z.object({
  scope: z.string().trim().min(1),
  objectives: z.array(z.string().trim().min(1)).min(1).max(8),
  assumedKnowledge: z.array(z.string().trim().min(1)).max(6).default([]),
  concepts: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        why: z.string().trim().min(1),
        hardBecause: z.string().trim().default(""),
      }),
    )
    .min(1)
    .max(10),
  examples: z
    .array(
      z.object({
        // A short slug the planner cites in a brief ("cart-total") so the
        // parallel writers can resolve it back to the same scenario.
        name: z.string().trim().min(1).max(60),
        scenario: z.string().trim().min(1),
        teaches: z.string().trim().default(""),
      }),
    )
    .min(1)
    .max(4),
  misconceptions: z
    .array(
      z.object({
        mistake: z.string().trim().min(1),
        whatBreaks: z.string().trim().default(""),
      }),
    )
    .max(6)
    .default([]),
  /**
   * Where a picture genuinely earns its place, and which library draws it. This
   * replaced the per-topic visual quota — an EMPTY list is a legitimate answer
   * for a lesson that is genuinely verbal.
   */
  visuals: z
    .array(
      z.object({
        concept: z.string().trim().min(1),
        kind: z.enum(VISUAL_KINDS),
        shows: z.string().trim().min(1),
      }),
    )
    .max(10)
    .default([]),
  outOfScope: z.array(z.string().trim().min(1)).max(6).default([]),
  /**
   * What the live web search established about the CURRENT state of this
   * subject — versions, renamed APIs, deprecated techniques, today's default
   * tooling. The analyst is the only call that sees the raw search results, so
   * this is how they reach the planner and the parallel topic writers; without
   * it every writer would fall back to its training cutoff. Empty when the
   * search found nothing decisive or freshness is disabled.
   */
  currency: z.array(z.string().trim().min(1)).max(8).default([]),
});
export type LessonBlueprint = z.infer<typeof lessonBlueprintSchema>;

export const emitLessonBlueprintTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_lesson_blueprint",
    description:
      "Emit your analysis of this one lesson before any lecture is planned. Call exactly once with the full structure.",
    parameters: {
      type: "object",
      // `currency` is required even though the zod schema defaults it to []:
      // left optional, gpt-4o-mini absorbed the search results into its scope
      // and examples but omitted the field entirely, so nothing current reached
      // the planner or the writers. Requiring the key forces the model to
      // decide; an empty array is still a legitimate answer.
      required: ["scope", "objectives", "concepts", "examples", "currency"],
      properties: {
        scope: {
          type: "string",
          description: "What this lesson actually teaches, restated in your own words from the curriculum instruction",
        },
        objectives: {
          type: "array",
          description: "3-6 things the student can DO after this lecture",
          items: { type: "string" },
        },
        assumedKnowledge: {
          type: "array",
          description: "What the student already knows and must NOT be re-taught",
          items: { type: "string" },
        },
        concepts: {
          type: "array",
          description: "The 3-8 ideas this lesson is made of, ordered easiest to hardest. This becomes the outline's spine.",
          items: {
            type: "object",
            required: ["name", "why", "hardBecause"],
            properties: {
              name: { type: "string" },
              why: { type: "string", description: "Why the student should care about this one" },
              hardBecause: { type: "string", description: "What beginners find genuinely difficult here" },
            },
          },
        },
        examples: {
          type: "array",
          description:
            "1-3 concrete worked examples the whole lecture will build. Every topic is written by a separate writer against THIS list, so name real scenarios, not placeholders.",
          items: {
            type: "object",
            required: ["name", "scenario", "teaches"],
            properties: {
              name: { type: "string", description: "Short slug used to cite it later, e.g. cart-total" },
              scenario: { type: "string", description: "The actual concrete situation, specific enough to code or work through" },
              teaches: { type: "string", description: "Which concepts this example demonstrates" },
            },
          },
        },
        misconceptions: {
          type: "array",
          description: "2-4 mistakes beginners actually make here",
          items: {
            type: "object",
            required: ["mistake", "whatBreaks"],
            properties: {
              mistake: { type: "string" },
              whatBreaks: { type: "string", description: "What actually goes wrong when they make it" },
            },
          },
        },
        visuals: {
          type: "array",
          description:
            "Only the ideas a picture genuinely clarifies. An empty list is a valid answer — do not invent visuals to fill this.",
          items: {
            type: "object",
            required: ["concept", "kind", "shows"],
            properties: {
              concept: { type: "string", description: "Which concept from concepts[] this draws" },
              kind: { type: "string", enum: [...VISUAL_KINDS] },
              shows: { type: "string", description: "What the picture must make visible" },
            },
          },
        },
        outOfScope: {
          type: "array",
          description: "Related ground that belongs to the SIBLING lessons and must not be taught here",
          items: { type: "string" },
        },
        currency: {
          type: "array",
          description:
            "What the CURRENT INFORMATION block establishes about this subject today, as instructions the writers must follow — current version numbers, renamed or removed APIs, techniques that are now deprecated and what replaced them, the tool that is now standard. One short factual line each, only for facts the search actually supports. Empty when the search block is absent or says nothing that changes how this lesson is taught.",
          items: { type: "string" },
        },
      },
    },
  },
};

// --- Lesson kind (classifier output) ---

/**
 * Which of the two lecture lanes a lesson goes down.
 *
 * `setup` is narrow on purpose: the lesson's success condition is that a tool is
 * RUNNING on the student's own machine afterwards. A lesson that merely mentions
 * a tool, or teaches how to use one already installed, is a `concept` lesson —
 * misrouting one of those costs it its worked examples and its exam.
 */
export const LESSON_KINDS = ["concept", "setup"] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];

export const lessonKindSchema = z.object({
  kind: z.enum(LESSON_KINDS),
  reason: z.string().trim().default(""),
});

export const emitLessonKindTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_lesson_kind",
    description: "Classify this one lesson into a lecture lane. Call exactly once.",
    parameters: {
      type: "object",
      required: ["kind", "reason"],
      properties: {
        kind: {
          type: "string",
          enum: [...LESSON_KINDS],
          description:
            "setup = after this lesson a tool must be INSTALLED AND RUNNING on the student's own machine " +
            "(install an editor, SDK, runtime or database, create an account or API key, scaffold a project, " +
            "put something on the PATH). concept = everything else, including a lesson that only uses or " +
            "mentions a tool the student already has.",
        },
        reason: { type: "string", description: "One short sentence naming what decided it" },
      },
    },
  },
};

// --- Setup blueprint (setup-lane analyst output) ---

/**
 * What the analyst understood about a SETUP lesson. The concept blueprint's
 * concepts / worked examples / misconceptions do not apply here: nothing is
 * being reasoned about, something is being made to run. So the fields are the
 * ones an install guide is actually built from — what gets downloaded, what must
 * already be true, the ordered stages, the command that proves it worked, and
 * the ways it goes wrong.
 *
 * `currency` is carried over verbatim and matters MORE here than on the concept
 * lane: a stale version number in prose is a footnote, a stale version number in
 * an install command is a failed install.
 */
export const setupBlueprintSchema = z.object({
  goal: z.string().trim().min(1),
  tools: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        whatItIs: z.string().trim().min(1),
        whyThisOne: z.string().trim().default(""),
      }),
    )
    .min(1)
    .max(4),
  prerequisites: z
    .array(
      z.object({
        requirement: z.string().trim().min(1),
        howToCheck: z.string().trim().default(""),
      }),
    )
    .max(5)
    .default([]),
  stages: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        doesWhat: z.string().trim().min(1),
      }),
    )
    .min(2)
    .max(8),
  verification: z
    .array(
      z.object({
        what: z.string().trim().min(1),
        command: z.string().trim().default(""),
        expected: z.string().trim().min(1),
      }),
    )
    .min(1)
    .max(5),
  pitfalls: z
    .array(
      z.object({
        symptom: z.string().trim().min(1),
        cause: z.string().trim().default(""),
        fix: z.string().trim().min(1),
      }),
    )
    .min(1)
    .max(8),
  /**
   * Mermaid only, and rarely. An install guide is a sequence of screens; the one
   * picture that ever earns its place is the shape of the whole flow. There is
   * no svg on this lane at all.
   */
  visuals: z
    .array(
      z.object({
        concept: z.string().trim().min(1),
        kind: z.literal("mermaid"),
        shows: z.string().trim().min(1),
      }),
    )
    .max(2)
    .default([]),
  outOfScope: z.array(z.string().trim().min(1)).max(6).default([]),
  currency: z.array(z.string().trim().min(1)).max(8).default([]),
});
export type SetupBlueprint = z.infer<typeof setupBlueprintSchema>;

export const emitSetupBlueprintTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_setup_blueprint",
    description:
      "Emit your analysis of this one setup/installation lesson before any guide is planned. Call exactly once.",
    parameters: {
      type: "object",
      required: ["goal", "tools", "stages", "verification", "pitfalls", "currency"],
      properties: {
        goal: {
          type: "string",
          description: "What is installed, configured and RUNNING on the student's machine when this lesson ends",
        },
        tools: {
          type: "array",
          description: "The 1-3 things actually being installed or signed up for. Name them exactly as the vendor does.",
          items: {
            type: "object",
            required: ["name", "whatItIs", "whyThisOne"],
            properties: {
              name: { type: "string", description: "The official product name, e.g. 'Visual Studio Code'" },
              whatItIs: { type: "string", description: "One plain sentence: what this thing does for them" },
              whyThisOne: { type: "string", description: "Why this tool rather than an alternative" },
            },
          },
        },
        prerequisites: {
          type: "array",
          description: "What must already be true before they start — OS version, disk space, admin rights, an existing runtime, an account",
          items: {
            type: "object",
            required: ["requirement", "howToCheck"],
            properties: {
              requirement: { type: "string" },
              howToCheck: { type: "string", description: "The exact way they confirm it, ideally a command" },
            },
          },
        },
        stages: {
          type: "array",
          description:
            "The ordered stages of getting this working — download, run the installer, first launch, configure, verify. This becomes the outline's spine.",
          items: {
            type: "object",
            required: ["name", "doesWhat"],
            properties: {
              name: { type: "string" },
              doesWhat: { type: "string", description: "What the student actually does in this stage" },
            },
          },
        },
        verification: {
          type: "array",
          description:
            "How the student PROVES it worked. Each is a concrete check with the exact expected result — this becomes the closing checklist.",
          items: {
            type: "object",
            required: ["what", "command", "expected"],
            properties: {
              what: { type: "string", description: "What is being verified" },
              command: { type: "string", description: "The exact command to run, or empty if it is a UI check" },
              expected: { type: "string", description: "Exactly what they should see — not 'it works'" },
            },
          },
        },
        pitfalls: {
          type: "array",
          description:
            "2-6 ways this install actually fails, in the student's words. Real ones — 'command not found after install', 'installer blocked by SmartScreen' — not generic advice.",
          items: {
            type: "object",
            required: ["symptom", "cause", "fix"],
            properties: {
              symptom: { type: "string", description: "What the student sees" },
              cause: { type: "string", description: "Why it happens" },
              fix: { type: "string", description: "What to do about it" },
            },
          },
        },
        visuals: {
          type: "array",
          description:
            "At most one mermaid diagram, and only if the overall flow is genuinely hard to hold in the head. An empty list is the normal answer for an install guide.",
          items: {
            type: "object",
            required: ["concept", "kind", "shows"],
            properties: {
              concept: { type: "string" },
              kind: { type: "string", enum: ["mermaid"] },
              shows: { type: "string" },
            },
          },
        },
        outOfScope: {
          type: "array",
          description: "Ground that belongs to the SIBLING lessons — usually 'actually using the tool'",
          items: { type: "string" },
        },
        currency: {
          type: "array",
          description:
            "What the CURRENT INFORMATION block establishes about installing this today — the current version, a renamed download, an installer that no longer exists, the package manager that is now standard. One short factual line each, only for facts the search actually supports. Empty when the search says nothing that changes these steps.",
          items: { type: "string" },
        },
      },
    },
  },
};

// --- Planner output ---

// `diagram` is intentionally absent: Mermaid supersedes the five preset layouts
// and keeping both would make the planner dither between two ways to draw the
// same thing. The diagram schema and renderer stay for lectures cached before
// this change; new plans use mermaid/tree/chart instead.
export const BLOCK_PLAN_TYPES = [
  "heading", "paragraph", "list", "callout", "code", "table", "math", "chart", "mermaid", "tree", "quiz", "svg",
] as const;

/**
 * Hard cap, not a runaway guard: svg is now a last resort. Library-backed
 * visuals (mermaid/tree/chart) render for a fraction of the cost and lay
 * themselves out, so a lecture rarely needs a hand-drawn svg — and the few it
 * does are worth a strong model. Exceeding this fails the plan.
 */
export const MAX_SVG_BLOCKS = 3;

/**
 * Depth floor, averaged across the outline rather than applied per topic: an
 * intro or a recap is legitimately two blocks, while a concept topic needs
 * heading + explanation + example + mistake. Set at 3 so an 8-topic lecture
 * must reach 24 blocks — the low end of the 25-60 the prompt asks for.
 */
export const MIN_BLOCKS_PER_TOPIC = 3;

/**
 * There is no longer a per-topic visual quota. Requiring one made the planner
 * bolt a diagram onto motivation, definition and recap topics purely to satisfy
 * the validator, which cost the student attention and taught nothing. Where a
 * picture genuinely helps is decided upstream by the lesson analyst's `visuals`
 * list, and the planner is told to follow it rather than fill a quota.
 */

export const plannedBlockSchema = z.object({
  type: z.enum(BLOCK_PLAN_TYPES),
  topicId: z.number().int().min(1),
  // What this block must teach/show, including a narration hint for visuals.
  brief: z.string().trim().min(1),
  // svg only: request SMIL animation.
  animated: z.boolean().optional(),
});
export type PlannedBlock = z.infer<typeof plannedBlockSchema>;

/**
 * The structural rules both lanes share: every block belongs to a real outline
 * topic, and every outline topic gets blocks. Factored out so the setup plan
 * cannot drift from the concept plan on the two rules that make assembly safe —
 * index.ts indexes topics by id and would throw on a dangling one.
 */
function refineTopicCoverage(
  plan: { outline: { id: number }[]; blocks: { topicId: number }[] },
  ctx: z.RefinementCtx,
): void {
  const ids = new Set(plan.outline.map((t) => t.id));
  plan.blocks.forEach((b, i) => {
    if (!ids.has(b.topicId)) {
      ctx.addIssue({
        code: "custom",
        path: ["blocks", i, "topicId"],
        message: `topicId ${b.topicId} is not an outline topic id`,
      });
    }
  });
  for (const id of ids) {
    if (!plan.blocks.some((b) => b.topicId === id)) {
      ctx.addIssue({ code: "custom", path: ["outline"], message: `outline topic ${id} has no blocks` });
    }
  }
}

export const lecturePlanSchema = z
  .object({
    title: z.string().trim().min(1),
    outline: z.array(outlineItemSchema).min(2).max(16),
    // Sanity ceiling only. The planner emits one-line briefs, and the content
    // itself is written by one parallel call per topic, so a long lecture never
    // has to fit in a single response.
    blocks: z.array(plannedBlockSchema).min(6).max(120),
  })
  .superRefine((plan, ctx) => {
    refineTopicCoverage(plan, ctx);
    // Depth floor. The planner reliably undershoots: asked for 25-60 blocks it
    // returned 18 across 8 topics, several of them a single paragraph — which
    // introduces an idea rather than teaching it. Prompt wording did not move
    // it, so, like the rules above, it is a parse failure the repair round fixes.
    const minBlocks = plan.outline.length * MIN_BLOCKS_PER_TOPIC;
    if (plan.blocks.length < minBlocks) {
      ctx.addIssue({
        code: "custom",
        path: ["blocks"],
        message:
          `only ${plan.blocks.length} blocks for ${plan.outline.length} outline topics — this lecture is too thin ` +
          `to teach. Plan at least ${minBlocks}: give every concept topic its own heading, an explanation, the ` +
          `worked example and the common mistake. Keep the same outline; add the missing blocks.`,
      });
    }
    // Each topic must be more than a single block — a lone paragraph under a
    // topic title is an outline entry pretending to be teaching.
    for (const t of plan.outline) {
      const count = plan.blocks.filter((b) => b.topicId === t.id).length;
      if (count === 1 && t.id !== plan.outline[plan.outline.length - 1]?.id) {
        ctx.addIssue({
          code: "custom",
          path: ["blocks"],
          message: `outline topic ${t.id} ("${t.title}") has only one block — give it a heading plus real content`,
        });
      }
    }
    // ONE dedicated quiz, and it closes the lecture. The old prompt asked for a
    // quiz "ending most topics", which broke the teaching arc into a series of
    // tests; the arc now runs intro → concepts → recap → check your
    // understanding. A cheap model will not hold that from the prompt alone, so
    // — like the topicId rules above — it is a parse failure the repair round fixes.
    const quizIndexes = plan.blocks.flatMap((b, i) => (b.type === "quiz" ? [i] : []));
    if (quizIndexes.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["blocks"],
        message:
          `expected exactly one quiz block (got ${quizIndexes.length}) — the lecture ends with a single ` +
          `dedicated quiz, and no topic carries its own checkpoint quiz`,
      });
    } else {
      const quizIndex = quizIndexes[0]!;
      if (quizIndex !== plan.blocks.length - 1) {
        ctx.addIssue({
          code: "custom",
          path: ["blocks", quizIndex],
          message: "the quiz must be the very last block of the lecture — nothing may follow it",
        });
      }
      const lastTopicId = plan.outline[plan.outline.length - 1]?.id;
      if (plan.blocks[quizIndex]!.topicId !== lastTopicId) {
        ctx.addIssue({
          code: "custom",
          path: ["blocks", quizIndex, "topicId"],
          message: `the quiz must belong to the final outline topic (${lastTopicId})`,
        });
      }
    }
    // svg is a last resort — expensive to draw and reserved for custom spatial
    // ideas no library expresses. The rest of the lecture's visuals are
    // mermaid/tree/chart, which are near-free.
    if (plan.blocks.filter((b) => b.type === "svg").length > MAX_SVG_BLOCKS) {
      ctx.addIssue({
        code: "custom",
        path: ["blocks"],
        message: `at most ${MAX_SVG_BLOCKS} svg blocks per lecture — use mermaid, tree or chart for the rest`,
      });
    }
  });
export type LecturePlan = z.infer<typeof lecturePlanSchema>;

/**
 * The setup lane's palette. No `quiz` (the lecture closes on a checklist, not an
 * exam), no `svg` (an install guide's one useful picture is a flow, which
 * mermaid draws for free), no `chart`, `tree` or `math` (nothing here is
 * numeric, hierarchical or algebraic — offering them only invites decoration).
 */
export const SETUP_BLOCK_PLAN_TYPES = [
  "heading", "paragraph", "list", "callout", "code", "table", "mermaid", "downloads", "checklist",
] as const;

export const setupPlannedBlockSchema = z.object({
  type: z.enum(SETUP_BLOCK_PLAN_TYPES),
  topicId: z.number().int().min(1),
  brief: z.string().trim().min(1),
});
export type SetupPlannedBlock = z.infer<typeof setupPlannedBlockSchema>;

/** Either lane's plan entry — what index.ts and the workers actually handle. */
export type AnyPlannedBlock = PlannedBlock | SetupPlannedBlock;

/**
 * Setup topics are legitimately step-list shaped — "Run the installer" can be a
 * heading plus one numbered list — so the floor is lower than the concept lane's
 * MIN_BLOCKS_PER_TOPIC of 3.
 */
export const MIN_SETUP_BLOCKS_PER_TOPIC = 2;

export const setupLecturePlanSchema = z
  .object({
    title: z.string().trim().min(1),
    outline: z.array(outlineItemSchema).min(2).max(16),
    blocks: z.array(setupPlannedBlockSchema).min(6).max(120),
  })
  .superRefine((plan, ctx) => {
    refineTopicCoverage(plan, ctx);

    const minBlocks = plan.outline.length * MIN_SETUP_BLOCKS_PER_TOPIC;
    if (plan.blocks.length < minBlocks) {
      ctx.addIssue({
        code: "custom",
        path: ["blocks"],
        message:
          `only ${plan.blocks.length} blocks for ${plan.outline.length} outline topics — this guide is too thin ` +
          `to follow. Plan at least ${minBlocks}: give every stage its own heading and the numbered steps that ` +
          `carry it out. Keep the same outline; add the missing blocks.`,
      });
    }

    // ONE downloads block, and it comes BEFORE the install steps. The links are
    // filled in by the server from a live search, so the planner is only
    // choosing where the section sits — and a download section placed after the
    // installation instructions is a guide the student cannot start.
    const downloadIndexes = plan.blocks.flatMap((b, i) => (b.type === "downloads" ? [i] : []));
    if (downloadIndexes.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["blocks"],
        message:
          `expected exactly one downloads block (got ${downloadIndexes.length}) — the guide has a single ` +
          `download section, and it is where the student gets the software`,
      });
    } else if (downloadIndexes[0]! >= Math.floor(plan.blocks.length / 2)) {
      ctx.addIssue({
        code: "custom",
        path: ["blocks", downloadIndexes[0]!],
        message:
          "the downloads block must come in the FIRST HALF of the guide, before the installation steps — " +
          "the student cannot install something they have not downloaded yet",
      });
    }

    // The guide ends by proving it worked, not by asserting it.
    const last = plan.blocks[plan.blocks.length - 1];
    if (last?.type !== "checklist") {
      ctx.addIssue({
        code: "custom",
        path: ["blocks", plan.blocks.length - 1],
        message:
          `the last block must be a checklist (got ${last?.type ?? "nothing"}) — a setup lesson closes with the ` +
          `verification checklist the student ticks off, and never with a quiz`,
      });
    }
    if (plan.blocks.filter((b) => b.type === "checklist").length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["blocks"],
        message: "exactly one checklist block, and it is the last one",
      });
    }

    // Every install goes wrong for somebody. A guide with no troubleshooting
    // section abandons exactly the students who most needed it.
    if (!plan.blocks.some((b) => b.type === "table")) {
      ctx.addIssue({
        code: "custom",
        path: ["blocks"],
        message:
          "plan a table block for troubleshooting — columns Symptom | Why it happens | Fix, one row per way " +
          "this install actually fails",
      });
    }
  });
export type SetupLecturePlan = z.infer<typeof setupLecturePlanSchema>;

export const emitSetupLecturePlanTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_setup_plan",
    description: "Emit the complete setup-guide plan. Call exactly once with the full structure.",
    parameters: {
      type: "object",
      required: ["title", "outline", "blocks"],
      properties: {
        title: { type: "string", description: "Guide title shown in the classroom top bar" },
        outline: {
          type: "array",
          description: "Every ordered stage of the setup (usually 5-9)",
          items: {
            type: "object",
            required: ["id", "title", "duration"],
            properties: {
              id: { type: "integer", description: "1-based topic id" },
              title: { type: "string" },
              duration: { type: "string", pattern: "^\\d+:\\d{2}$", description: "m:ss estimate" },
            },
          },
        },
        blocks: {
          type: "array",
          description:
            "Ordered plan of every block. Exactly one downloads block, in the first half. Exactly one checklist block, and it is the last entry. At least one table, for troubleshooting. No quiz.",
          items: {
            type: "object",
            required: ["type", "topicId", "brief"],
            properties: {
              type: { type: "string", enum: [...SETUP_BLOCK_PLAN_TYPES] },
              topicId: { type: "integer", description: "Outline topic this block belongs to" },
              brief: {
                type: "string",
                description:
                  "What the block must say or show. For the downloads block just say which tool's downloads it is — the links themselves are found by the system, not by you.",
              },
            },
          },
        },
      },
    },
  },
};

// --- Worker emissions ---

export const topicBlocksEmissionSchema = z.object({ blocks: z.array(easyBlockSchema).min(1) });
export const svgEmissionSchema = z.object({
  svg: z.string().min(20),
  alt: z.string().trim().min(1),
  caption: z.string().optional(),
});

// --- Forced tools (hand-written JSON Schema; the zod above is the enforcement) ---

export const emitLecturePlanTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_lecture_plan",
    description: "Emit the complete lecture plan. Call exactly once with the full structure.",
    parameters: {
      type: "object",
      required: ["title", "outline", "blocks"],
      properties: {
        title: { type: "string", description: "Lecture title shown in the classroom top bar" },
        outline: {
          type: "array",
          description: "Every ordered lecture topic the lesson needs (usually 5-12)",
          items: {
            type: "object",
            required: ["id", "title", "duration"],
            properties: {
              id: { type: "integer", description: "1-based topic id" },
              title: { type: "string" },
              duration: { type: "string", pattern: "^\\d+:\\d{2}$", description: "m:ss estimate" },
            },
          },
        },
        blocks: {
          type: "array",
          description:
            "Ordered plan of every content block the lesson needs (typically 20-60). Exactly one quiz block, and it is the last entry.",
          items: {
            type: "object",
            required: ["type", "topicId", "brief"],
            properties: {
              type: { type: "string", enum: [...BLOCK_PLAN_TYPES] },
              topicId: { type: "integer", description: "Outline topic this block belongs to" },
              brief: {
                type: "string",
                description: "What the block must teach/show; for visuals include what the alt/narration should convey",
              },
              animated: { type: "boolean", description: "svg only: true when the diagram should be SMIL-animated" },
            },
          },
        },
      },
    },
  },
};

export const emitTopicBlocksTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_topic_blocks",
    description:
      "Emit the final content blocks for this topic, in the planned order — exactly as many blocks as planned. Call exactly once.",
    parameters: {
      type: "object",
      required: ["blocks"],
      properties: {
        blocks: {
          type: "array",
          items: {
            type: "object",
            required: ["type"],
            properties: {
              type: {
                type: "string",
                enum: ["heading", "paragraph", "list", "callout", "code", "table", "math", "chart", "mermaid", "tree", "quiz"],
              },
              text: { type: "string", description: "heading/paragraph/callout body" },
              alt: { type: "string", description: "mermaid/tree only: narration + accessibility description" },
              columns: { type: "array", items: { type: "string" }, description: "table only: 1-6 header labels" },
              rows: {
                type: "array",
                description: "table only: each row an array of cell strings, one per column",
                items: { type: "array", items: { type: "string" } },
              },
              tex: { type: "string", description: "math only: raw LaTeX math, no surrounding $" },
              display: { type: "boolean", description: "math only: true = centred block equation" },
              root: {
                type: "object",
                description: "tree only: the root node. Recursive { name, attributes?, children? }.",
                properties: {
                  name: { type: "string" },
                  attributes: { type: "object", description: "optional key→value labels shown on the node" },
                  children: { type: "array", description: "child nodes, same shape (max depth ~4)", items: { type: "object" } },
                },
              },
              orientation: { type: "string", enum: ["vertical", "horizontal"], description: "tree only" },
              level: { type: "integer", enum: [1, 2, 3], description: "heading only" },
              muted: { type: "boolean", description: "paragraph only" },
              style: { type: "string", enum: ["bullet", "numbered"], description: "list only" },
              items: { type: "array", items: { type: "string" }, description: "list only, 3-10 entries" },
              tone: { type: "string", enum: ["info", "success", "warning"], description: "callout only" },
              icon: { type: "string", enum: [...ICON_NAMES], description: "callout/diagram nodes" },
              language: { type: "string", description: "code only, e.g. python" },
              code: { type: "string", description: "code block source, OR the Mermaid DSL for a mermaid block" },
              chartType: { type: "string", enum: ["bar", "line", "pie", "donut"], description: "chart only" },
              title: { type: "string", description: "chart/quiz title" },
              data: {
                type: "object",
                description: "chart only",
                properties: {
                  labels: { type: "array", items: { type: "string" } },
                  series: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["name", "values"],
                      properties: {
                        name: { type: "string" },
                        values: { type: "array", items: { type: "number" } },
                        color: { type: "string", enum: [...COLOR_TOKENS] },
                      },
                    },
                  },
                },
              },
              questions: {
                type: "array",
                description: "quiz only: 6-8 questions covering the whole lecture (it is the only quiz)",
                items: {
                  type: "object",
                  required: ["question", "options", "correctIndex", "explanation", "concept"],
                  properties: {
                    question: { type: "string" },
                    options: { type: "array", items: { type: "string" }, description: "2-4 options" },
                    correctIndex: { type: "integer", description: "0-based index into options" },
                    explanation: { type: "string", description: "Shown after answering" },
                    concept: {
                      type: "string",
                      description:
                        "The single concept from the lesson brief this question tests, named exactly as the brief names it",
                    },
                  },
                },
              },
              caption: { type: "string", description: "Muted line under the block; narration-friendly" },
              sideText: { type: "string", description: "Optional right-hand column note" },
            },
          },
        },
      },
    },
  },
};

/**
 * The setup lane's writer tool. A separate tool rather than a flag on
 * `emit_topic_blocks`: the properties a quiz, a chart and a tree need are pure
 * noise to a writer producing install steps, and every one of them is another
 * shape the model can reach for by mistake. What is left is the palette an
 * install guide is actually made of, plus `checks` for the closing checklist.
 *
 * Note what is NOT here, on either tool: any property that could hold a url.
 * The download links come from the server's own search results.
 */
export const emitSetupBlocksTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_setup_blocks",
    description:
      "Emit the final blocks for this stage of the setup guide, in the planned order — exactly as many blocks as planned. Call exactly once.",
    parameters: {
      type: "object",
      required: ["blocks"],
      properties: {
        blocks: {
          type: "array",
          items: {
            type: "object",
            required: ["type"],
            properties: {
              type: {
                type: "string",
                enum: ["heading", "paragraph", "list", "callout", "code", "table", "mermaid", "checklist"],
              },
              text: { type: "string", description: "heading/paragraph/callout body" },
              level: { type: "integer", enum: [1, 2, 3], description: "heading only" },
              muted: { type: "boolean", description: "paragraph only" },
              style: {
                type: "string",
                enum: ["bullet", "numbered"],
                description: "list only — use \"numbered\" for anything the student performs in order",
              },
              items: { type: "array", items: { type: "string" }, description: "list only, 3-10 entries" },
              tone: { type: "string", enum: ["info", "success", "warning"], description: "callout only" },
              icon: { type: "string", enum: [...ICON_NAMES], description: "callout only" },
              language: {
                type: "string",
                description: "code only — powershell, bash, zsh, cmd, or the language of the snippet",
              },
              code: { type: "string", description: "code block source, OR the Mermaid DSL for a mermaid block" },
              alt: { type: "string", description: "mermaid only: narration + accessibility description" },
              columns: { type: "array", items: { type: "string" }, description: "table only: 1-6 header labels" },
              rows: {
                type: "array",
                description: "table only: each row an array of cell strings, one per column",
                items: { type: "array", items: { type: "string" } },
              },
              title: { type: "string", description: "checklist title" },
              checks: {
                type: "array",
                description:
                  "checklist only: what the student ticks off to prove the setup worked. Each is one verifiable thing.",
                items: {
                  type: "object",
                  required: ["text"],
                  properties: {
                    text: { type: "string", description: "The thing that should now be true" },
                    command: { type: "string", description: "The exact command that proves it, when there is one" },
                    expected: { type: "string", description: "Exactly what they should see — never \"it works\"" },
                  },
                },
              },
              caption: { type: "string", description: "Muted line under the block; narration-friendly" },
              sideText: { type: "string", description: "Optional right-hand column note" },
            },
          },
        },
      },
    },
  },
};

/**
 * The downloads picker. Same shape as `emit_resource_picks` and for the same
 * reason: there is no `url` property, so the model can only answer with the
 * number of a candidate our own search returned. A hallucinated installer link
 * is unrepresentable rather than unlikely.
 */
export const emitDownloadPicksTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_download_picks",
    description:
      "Pick the official download pages for this setup lesson from the numbered candidate list. " +
      "You may ONLY reference candidates by their number. Never write a URL — any URL you write is discarded.",
    parameters: {
      type: "object",
      required: ["intro", "picks"],
      properties: {
        intro: {
          type: "string",
          description:
            "One short sentence introducing the download section, in the lecture's language. It is spoken " +
            "aloud by the voice tutor, so it must contain no URLs and no domain names.",
        },
        picks: {
          type: "array",
          description:
            "1-3 picks, the official vendor page first. Return fewer rather than padding with a mirror or a blog.",
          items: {
            type: "object",
            required: ["number", "label", "note", "kind"],
            properties: {
              number: { type: "integer", description: "The [n] of a candidate" },
              label: {
                type: "string",
                description: "What the student is clicking, in their language, e.g. \"Visual Studio Code for Windows\"",
              },
              note: {
                type: "string",
                description: "One short line: which file to choose there, or what to expect on the page",
              },
              kind: {
                type: "string",
                enum: [...DOWNLOAD_KINDS],
                description: "installer = a direct download page, page = the product's main site, docs = install docs",
              },
            },
          },
        },
      },
    },
  },
};

export const emitSvgBlockTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_svg_block",
    description: "Emit the finished SVG diagram. Call exactly once.",
    parameters: {
      type: "object",
      required: ["svg", "alt"],
      properties: {
        svg: {
          type: "string",
          description:
            "Full inline SVG markup starting with <svg and including a viewBox. Colors via the app CSS variables only.",
        },
        alt: { type: "string", description: "Narration-quality description of the diagram" },
        caption: { type: "string", description: "Optional muted caption below the diagram" },
      },
    },
  },
};

/**
 * The resources picker. Note what this tool CANNOT express: a URL, and a second
 * video. Candidates are referenced by number only, so the link the student
 * clicks always comes from our search results; and `video` is one object rather
 * than an array, so "exactly one video" is structural instead of prompted.
 */
export const emitResourcePicksTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_resource_picks",
    description:
      "Pick the best further-reading links for this lecture from the numbered candidate lists. " +
      "You may ONLY reference candidates by their number. Never write a URL — any URL you write is discarded.",
    parameters: {
      type: "object",
      required: ["intro", "reading"],
      properties: {
        intro: {
          type: "string",
          description:
            "One warm sentence introducing the list, in the lecture's language. It is spoken aloud by the " +
            "voice tutor, so it must contain no URLs, no domain names and no punctuation-heavy text.",
        },
        reading: {
          type: "array",
          description:
            "2-4 picks from the READING list, best first. Return fewer rather than padding with anything off-topic.",
          items: {
            type: "object",
            required: ["number", "why"],
            properties: {
              number: { type: "integer", description: "The [n] of a READING candidate" },
              why: {
                type: "string",
                description: "One short line: why this is worth the student's time, in the lecture's language",
              },
            },
          },
        },
        video: {
          type: "object",
          description:
            "The single best VIDEO candidate. Fill this in whenever the VIDEO list is non-empty — omit it only " +
            "when there are no candidates at all, or every one is plainly about a different subject.",
          required: ["number", "why"],
          properties: {
            number: { type: "integer", description: "The [n] of a VIDEO candidate" },
            why: { type: "string", description: "One short line, in the lecture's language" },
          },
        },
      },
    },
  },
};
