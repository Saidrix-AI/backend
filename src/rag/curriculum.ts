import type OpenAI from "openai";
import { z } from "zod";
import { env } from "../config/env.js";
import { getModelName, hasOpenAICompatProvider } from "../agents/llm.js";
import { formatZodIssues, runForcedToolCall, type LlmDeps } from "../agents/shared/forcedToolCall.js";
import { CurriculumTemplateModel } from "../database/models/curriculumTemplate.model.js";

/**
 * Saidrix's own course designs (the lesson PDFs), as structured templates, and
 * the one question everything upstream asks of them: "is there a template for
 * what this student wants, and which course in it?"
 *
 * Matching is a model call over the short list of templates, not a vector
 * search: "I want to build Android apps' servers" has to land on the Android
 * BACKEND roadmap, and similarity search cannot tell it from the frontend one.
 */

export type TemplateKind = "foundation" | "roadmap" | "guide";

export interface TemplateModule {
  title: string;
  topics: string;
}
export interface TemplateCourse {
  title: string;
  summary: string;
  status: string;
  modules: TemplateModule[];
  tools: string;
  project: string;
}
export interface Template {
  sourcePath: string;
  kind: TemplateKind;
  skill: string;
  summary: string;
  aliases: string[];
  courses: TemplateCourse[];
}

export interface CurriculumMatch {
  template: Template;
  /** Which course of a roadmap the request is about; null = the whole roadmap. */
  courseIndex: number | null;
}

function resolveDeps(): LlmDeps | null {
  if (!hasOpenAICompatProvider()) return null;
  return { model: env.COURSE_MAKER_MODEL ?? getModelName() };
}

// ---------------------------------------------------------------- extraction

const extractionSchema = z.object({
  kind: z.enum(["foundation", "roadmap", "guide"]),
  skill: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(600).default(""),
  aliases: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
  courses: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(160),
        summary: z.string().trim().max(500).default(""),
        status: z.string().trim().max(120).default(""),
        modules: z
          .array(z.object({ title: z.string().trim().min(1).max(160), topics: z.string().trim().max(600).default("") }))
          .max(16)
          .default([]),
        tools: z.string().trim().max(600).default(""),
        project: z.string().trim().max(400).default(""),
      }),
    )
    .max(16)
    .default([]),
});

const emitTemplateTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_curriculum_template",
    description: "Emit the structured course template this document describes. Call exactly once.",
    parameters: {
      type: "object",
      required: ["kind", "skill", "summary", "aliases", "courses"],
      properties: {
        kind: {
          type: "string",
          enum: ["foundation", "roadmap", "guide"],
          description:
            "foundation = ONE complete course for one language/technology (its modules). roadmap = a role's ordered list of courses (steps). guide = reference material with no course structure.",
        },
        skill: { type: "string", description: "What it teaches, e.g. 'Python' or 'Android Backend Development'" },
        summary: { type: "string", description: "Two sentences: who it is for and what it covers" },
        aliases: {
          type: "array",
          items: { type: "string" },
          description: "Other names a learner might use for this (abbreviations, role names)",
        },
        courses: {
          type: "array",
          description:
            "foundation: exactly one course holding all its modules. roadmap: one entry per step, in order. guide: empty.",
          items: {
            type: "object",
            required: ["title", "summary", "modules"],
            properties: {
              title: { type: "string" },
              summary: { type: "string" },
              status: { type: "string", description: "e.g. 'Core', 'Choose one', 'Optional' when stated" },
              modules: {
                type: "array",
                items: {
                  type: "object",
                  required: ["title", "topics"],
                  properties: {
                    title: { type: "string" },
                    topics: { type: "string", description: "Its topics and practice, condensed to one line" },
                  },
                },
              },
              tools: { type: "string", description: "Tools and alternatives, one line" },
              project: { type: "string", description: "The final project, one line" },
            },
          },
        },
      },
    },
  },
};

/** One PDF's text → its template. Used by the ingest script; throws on failure. */
export async function extractTemplate(text: string, sourcePath: string, deps?: LlmDeps): Promise<Template> {
  const resolved = deps ?? resolveDeps();
  if (!resolved) throw new Error("No LLM provider for template extraction");
  const data = await runForcedToolCall({
    deps: resolved,
    tool: emitTemplateTool,
    system:
      "You read one curriculum document and emit its structure exactly as written — course titles, module titles and topics copied from the document, never invented. Keep it in the document's language.",
    user: `Document: ${sourcePath}\n\n${text.slice(0, 60000)}`,
    parse: (raw) => {
      const r = extractionSchema.safeParse(decodeNested(raw));
      return r.success ? { success: true, data: r.data } : { success: false, issues: formatZodIssues(r.error) };
    },
    sizeHint: "Condense every topics line to a short phrase.",
    maxTokens: 8000,
    label: "Curriculum template",
  });
  return { sourcePath, ...data };
}

/** Models sometimes send a nested array as a JSON string. */
function decodeNested(raw: unknown): unknown {
  const obj = raw as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") return raw;
  const out: Record<string, unknown> = { ...obj };
  for (const key of ["courses", "aliases"]) {
    if (typeof out[key] === "string") {
      try {
        out[key] = JSON.parse(out[key] as string);
      } catch {
        /* left for zod to report */
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ storage

let cache: { at: number; templates: Template[] } | null = null;
const CACHE_MS = 10 * 60_000;

export async function listTemplates(): Promise<Template[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.templates;
  const docs = await CurriculumTemplateModel.find({}).sort({ sourcePath: 1 }).lean();
  const templates = docs as unknown as Template[];
  cache = { at: Date.now(), templates };
  return templates;
}

export async function saveTemplates(templates: Template[]): Promise<void> {
  await CurriculumTemplateModel.deleteMany({ sourcePath: { $nin: templates.map((t) => t.sourcePath) } });
  for (const t of templates) {
    await CurriculumTemplateModel.updateOne({ sourcePath: t.sourcePath }, { $set: t }, { upsert: true });
  }
  cache = null;
}

// ----------------------------------------------------------------- matching

const matchSchema = z.object({
  templateNumber: z.number().int().min(0),
  courseNumber: z.number().int().min(0).default(0),
});

const emitMatchTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_curriculum_match",
    description: "Say which curriculum template fits the learner's request. Call exactly once.",
    parameters: {
      type: "object",
      required: ["templateNumber", "courseNumber"],
      properties: {
        templateNumber: {
          type: "integer",
          description: "The number of the matching template, or 0 when none genuinely fits",
        },
        courseNumber: {
          type: "integer",
          description:
            "For a roadmap: the number of the ONE course the request is about, or 0 when the request is the whole role/path",
        },
      },
    },
  },
};

const matchMemo = new Map<string, { at: number; match: CurriculumMatch | null }>();

function templateLine(t: Template, n: number): string {
  const courses =
    t.kind === "roadmap"
      ? ` — courses: ${t.courses.map((c, i) => `${i + 1}) ${c.title}`).join("; ")}`
      : "";
  const aka = t.aliases.length ? ` (also: ${t.aliases.slice(0, 4).join(", ")})` : "";
  return `${n}. [${t.kind}] ${t.skill}${aka}${courses}`;
}

/**
 * The template for a learner's request, or null. Never throws — no match only
 * means the course is designed from research instead of from a template.
 */
export async function matchCurriculum(request: string, deps?: LlmDeps): Promise<CurriculumMatch | null> {
  const key = request.trim().toLowerCase().slice(0, 400);
  const hit = matchMemo.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.match;

  const resolved = deps ?? resolveDeps();
  if (!resolved) return null;
  let templates: Template[];
  try {
    templates = (await listTemplates()).filter((t) => t.kind !== "guide");
  } catch {
    return null;
  }
  if (templates.length === 0) return null;

  let match: CurriculumMatch | null = null;
  try {
    const picked = await runForcedToolCall({
      deps: resolved,
      tool: emitMatchTool,
      system:
        "You match a learner's request to Saidrix's own curriculum. Pick the template that IS what they asked for — the same language, or the same role on the same platform. A request for one language is its foundation course, not a roadmap that happens to include it. Answer 0 when nothing genuinely fits; a near miss is worse than no template.",
      user: `Learner's request: ${request}\n\nTemplates:\n${templates.map((t, i) => templateLine(t, i + 1)).join("\n")}`,
      parse: (raw) => {
        const r = matchSchema.safeParse(raw);
        return r.success ? { success: true, data: r.data } : { success: false, issues: formatZodIssues(r.error) };
      },
      sizeHint: "Answer with the two numbers only.",
      maxTokens: 200,
      label: "Curriculum match",
    });
    const template = templates[picked.templateNumber - 1];
    if (template) {
      const c = picked.courseNumber;
      match = {
        template,
        courseIndex: template.kind === "roadmap" && c >= 1 && c <= template.courses.length ? c - 1 : null,
      };
    }
  } catch (err) {
    console.warn("[curriculum] match failed:", err instanceof Error ? err.message : err);
  }
  matchMemo.set(key, { at: Date.now(), match });
  console.info(
    `[curriculum] "${request.slice(0, 60)}" → ${match ? `${match.template.skill} (${match.template.kind}${match.courseIndex != null ? `, course ${match.courseIndex + 1}` : ""})` : "no template"}`,
  );
  return match;
}

// ---------------------------------------------------------------- rendering

export function formatCourse(c: TemplateCourse): string {
  return [
    `Course: ${c.title}${c.status ? ` [${c.status}]` : ""}`,
    c.summary ? `  ${c.summary}` : "",
    ...c.modules.map((m, i) => `  Module ${i + 1}: ${m.title}${m.topics ? ` — ${m.topics}` : ""}`),
    c.tools ? `  Tools: ${c.tools}` : "",
    c.project ? `  Final project: ${c.project}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The template as a prompt block. `courseIndex` narrows a roadmap to one course. */
export function formatTemplate(match: CurriculumMatch): string {
  const { template: t, courseIndex } = match;
  const courses = courseIndex != null ? [t.courses[courseIndex]!] : t.courses;
  return [
    `SAIDRIX CURRICULUM TEMPLATE — ${t.skill} (${t.kind})`,
    t.summary,
    ...courses.map(formatCourse),
  ]
    .filter(Boolean)
    .join("\n");
}
