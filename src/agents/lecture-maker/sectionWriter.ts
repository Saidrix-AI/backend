import { formatZodIssues, resolveLectureDeps, runForcedToolCall, type LlmDeps, type ParseResult } from "./call.js";
import { checkMermaidBlocks } from "./mermaid.js";
import type { LessonContext } from "./prompt.js";
import type { EasyBlock, LessonBlueprint, LessonKind, OutlineItem } from "./schema.js";
import {
  buildOutlineSystemPrompt,
  buildOutlineUserMessage,
  buildQuizSystemPrompt,
  buildQuizUserMessage,
  buildSectionWriterSystemPrompt,
  buildSectionWriterUserMessage,
  type Blueprint,
} from "./sectionPrompts.js";
import {
  emitLectureOutlineTool,
  emitQuizTool,
  emitSectionsTool,
  lectureOutlineSchema,
  quizEmissionSchema,
  sectionEmissionSchema,
  type LectureOutline,
  type SectionEmissionItem,
} from "./sections.js";

/** Language words a practical brief may name, mapped to a fence tag the Code Lab routes. */
const LANGUAGE_WORDS: [RegExp, string][] = [
  [/\bpython\b/i, "python"],
  [/\b(javascript|node\.?js|react)\b/i, "javascript"],
  [/\btypescript\b/i, "typescript"],
  [/\bjava\b/i, "java"],
  [/\bc\+\+|\bcpp\b/i, "cpp"],
  [/\bc#|\bcsharp\b/i, "csharp"],
  [/\bgo(lang)?\b/i, "go"],
  [/\brust\b/i, "rust"],
  [/\bruby\b/i, "ruby"],
  [/\bphp\b/i, "php"],
  [/\bkotlin\b/i, "kotlin"],
  [/\bswift\b/i, "swift"],
  [/\bsql\b/i, "sql"],
  [/\bhtml\b/i, "html"],
  [/\bcss\b/i, "css"],
  [/\b(bash|shell)\b/i, "bash"],
];

/**
 * Some models (nemotron-3-ultra among them) emit a deeply nested argument as a
 * JSON-encoded STRING — `{"sections": "[{...}]"}` — about half the time. The
 * content is right; only the encoding is wrong, so it is decoded here instead
 * of spending the repair round on it (which the same model fails the same way).
 */
export function decodeStringified(raw: unknown, key: string): unknown {
  const obj = raw as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object" || typeof obj[key] !== "string") return raw;
  try {
    return { ...obj, [key]: JSON.parse(obj[key] as string) };
  } catch {
    return raw;
  }
}

export async function runOutlinePlanner(
  ctx: LessonContext,
  blueprint: Blueprint,
  deps?: LlmDeps,
): Promise<LectureOutline> {
  return runForcedToolCall({
    deps: deps ?? resolveLectureDeps("planner"),
    tool: emitLectureOutlineTool,
    system: buildOutlineSystemPrompt(blueprint.kind),
    user: buildOutlineUserMessage(ctx, blueprint),
    parse: (raw) => {
      const r = lectureOutlineSchema.safeParse(decodeStringified(raw, "topics"));
      if (!r.success) return { success: false, issues: formatZodIssues(r.error) };
      // A setup guide has no practical sections — the Code Lab cannot install
      // software on the student's machine. Coerced, not rejected: the content
      // is still right, only where it is taught changes.
      if (blueprint.kind === "setup") {
        for (const t of r.data.topics) for (const s of t.sections) if (s.kind === "practical") s.kind = "theory";
      }
      return { success: true, data: r.data };
    },
    sizeHint: "Use fewer topics and shorter briefs.",
  });
}

/**
 * Writes one topic's sections. The planned count, order and kinds are
 * authoritative; titles and kinds are stamped from the plan afterwards so a
 * writer cannot quietly move a practical section onto the page.
 */
export async function runSectionWriter(
  ctx: LessonContext,
  outline: LectureOutline,
  topicIndex: number,
  blueprint: Blueprint,
  deps?: LlmDeps,
): Promise<SectionEmissionItem[]> {
  const planned = outline.topics[topicIndex]!.sections;
  return runForcedToolCall({
    deps: deps ?? resolveLectureDeps("worker"),
    tool: emitSectionsTool,
    system: buildSectionWriterSystemPrompt(blueprint.kind),
    user: buildSectionWriterUserMessage(ctx, outline, topicIndex, blueprint),
    parse: async (raw, at): Promise<ParseResult<SectionEmissionItem[]>> => {
      const decoded = decodeStringified(raw, "sections");
      const r = sectionEmissionSchema.safeParse(decoded);
      const got = Array.isArray((decoded as { sections?: unknown })?.sections)
        ? (decoded as { sections: unknown[] }).sections.length
        : 0;
      const reject = (issues: string) => {
        console.warn(`[lecture-maker] topic ${topicIndex + 1} sections rejected (attempt ${at.attempt + 1}): ${issues}`);
        return { success: false as const, issues };
      };
      if (!r.success) return reject(formatZodIssues(r.error));
      let sections = r.data.sections;
      if (got !== planned.length) {
        if (!at.isFinal) return reject(`expected exactly ${planned.length} sections in the planned order, got ${got}`);
        sections = sections.slice(0, planned.length);
      }
      sections = sections.map((s, i) => ({
        ...s,
        title: planned[i]?.title ?? s.title,
        kind: planned[i]?.kind ?? s.kind,
        blocks: backfillLanguage(s.blocks, planned[i]?.brief ?? ""),
      }));
      const mermaidIssue = await checkMermaidBlocks(
        sections.flatMap((s) => s.blocks),
        { isFinal: at.isFinal },
      );
      if (mermaidIssue && !at.isFinal) return reject(mermaidIssue);
      // Last attempt: a diagram that still will not parse costs only itself,
      // never the topic. A canvas section left with nothing to draw is taught
      // on the page instead.
      if (mermaidIssue) sections = await dropBrokenDiagrams(sections, topicIndex);
      return { success: true, data: sections };
    },
    sizeHint: "Shorten the longest blocks; still emit every planned section.",
  });
}

async function dropBrokenDiagrams(sections: SectionEmissionItem[], topicIndex: number): Promise<SectionEmissionItem[]> {
  const out: SectionEmissionItem[] = [];
  for (const s of sections) {
    const blocks: EasyBlock[] = [];
    for (const b of s.blocks) {
      if (b.type === "mermaid" && (await checkMermaidBlocks([b], { isFinal: true }))) {
        console.warn(`[lecture-maker] topic ${topicIndex + 1}: dropped an unparseable diagram in "${s.title}"`);
        continue;
      }
      blocks.push(b);
    }
    if (blocks.length === 0) continue;
    const drawable = blocks.some((b) => b.type === "mermaid" || b.type === "tree");
    out.push({ ...s, blocks, kind: s.kind === "canvas" && !drawable ? "theory" : s.kind });
  }
  return out;
}

/** A code block without a language cannot be run in the Code Lab — recover it from the brief. */
function backfillLanguage(blocks: EasyBlock[], brief: string): EasyBlock[] {
  return blocks.map((b) => {
    if (b.type !== "code" || b.language?.trim()) return b;
    const hit = LANGUAGE_WORDS.find(([p]) => p.test(brief));
    return hit ? { ...b, language: hit[1] } : b;
  });
}

export async function runQuizWriter(
  ctx: LessonContext,
  title: string,
  outline: OutlineItem[],
  sections: { title: string; goal: string }[],
  bp: LessonBlueprint,
  deps?: LlmDeps,
) {
  const quiz = await runForcedToolCall({
    deps: deps ?? resolveLectureDeps("worker"),
    tool: emitQuizTool,
    system: buildQuizSystemPrompt(),
    user: buildQuizUserMessage(ctx, title, outline, sections, bp),
    parse: (raw) => {
      const r = quizEmissionSchema.safeParse(decodeStringified(raw, "questions"));
      return r.success ? { success: true, data: r.data } : { success: false, issues: formatZodIssues(r.error) };
    },
    sizeHint: "Write 6 questions with shorter explanations.",
  });
  return quiz.questions;
}

export type { LessonKind };
