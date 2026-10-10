import { isResourcesEnabled } from "../../config/env.js";
import { ApiError } from "../../utils/apiError.js";
import { DEFAULT_LANGUAGE, type Language } from "../../validation/language.js";
import { buildLessonBlueprint, buildSetupBlueprint, retrieveLessonGrounding } from "./analyze.js";
import { resolveLectureDeps, type LlmDeps } from "./call.js";
import { classifyLesson } from "./classify.js";
import { buildDownloadsBlock, type DownloadsResult } from "./downloads.js";
import type { LessonContext } from "./prompt.js";
import { buildResourcesBlock, type ResourcesResult } from "./resources.js";
import type { LessonBlueprint, LessonKind, OutlineItem, SetupBlueprint } from "./schema.js";
import type { Blueprint } from "./sectionPrompts.js";
import { lectureV3Schema, type LectureOutline, type Section, type SectionEmissionItem } from "./sections.js";
import { runOutlinePlanner, runQuizWriter, runSectionWriter } from "./sectionWriter.js";

export type { LessonContext } from "./prompt.js";

/** Per-role deps injection seam — tests pass fake clients here. */
export interface LectureDeps {
  classifier?: LlmDeps;
  analyst?: LlmDeps;
  planner?: LlmDeps;
  worker?: LlmDeps;
  resources?: LlmDeps;
  downloads?: LlmDeps;
}

export interface MadeLecture {
  title: string;
  /** Whatever the course was generated in — see validation/language.ts. */
  language: Language;
  /** concept = an idea lesson; setup = an installation guide (checklist instead of exam). */
  kind: LessonKind;
  outline: OutlineItem[];
  sections: Section[];
}

/**
 * Emitted as the pipeline progresses, so lecture.service can relay real stages
 * to the classroom's loading screen. Purely observational.
 */
export type LectureProgressEvent =
  | { stage: "analyzing" }
  | { stage: "classified"; kind: LessonKind }
  | { stage: "analyzed"; concepts: number; visuals: number }
  | { stage: "planning" }
  | { stage: "planned"; topics: number; sections: number }
  | { stage: "topic"; status: "start" | "done"; index: number; total: number; title: string }
  | { stage: "quiz"; status: "start" | "done" | "skipped" }
  | { stage: "downloads"; status: "start" | "done" | "skipped"; links?: number }
  | { stage: "resources"; status: "start" | "done" | "skipped"; links?: number }
  | { stage: "assembling" };

type Progress = (event: LectureProgressEvent) => void;

/**
 * One lecture pipeline for every lesson:
 *
 *   classify → ground (RAG + live search) → analyse → outline (topics and
 *   sections, each tagged theory / practical / canvas) → one section writer
 *   per topic in parallel (page content + tutor instructions together) → quiz
 *   (concept) or checklist (setup) → resources / downloads → assemble.
 *
 * A setup lesson differs only in its analyst and in the writers' rules; the
 * shape of what comes out is identical.
 */
export async function makeLecture(
  ctx: LessonContext,
  deps?: LectureDeps,
  onProgress?: Progress,
): Promise<MadeLecture> {
  onProgress?.({ stage: "analyzing" });
  const [kind, { grounding, freshness }] = await Promise.all([
    classifyLesson(ctx, deps?.classifier),
    retrieveLessonGrounding(ctx),
  ]);
  onProgress?.({ stage: "classified", kind });

  const analystDeps = deps?.analyst ?? resolveLectureDeps("analyst");
  const blueprint: Blueprint =
    kind === "setup"
      ? { kind: "setup", bp: await buildSetupBlueprint(ctx, grounding, freshness, analystDeps) }
      : { kind: "concept", bp: await buildLessonBlueprint(ctx, grounding, freshness, analystDeps) };
  const lesson = blueprint.kind === "setup" ? setupBlueprintAsLesson(blueprint.bp) : blueprint.bp;
  onProgress?.({
    stage: "analyzed",
    concepts: blueprint.kind === "setup" ? blueprint.bp.stages.length : blueprint.bp.concepts.length,
    visuals: blueprint.bp.visuals.length,
  });

  // The link sections need only the lesson and the analyst's scope, so they run
  // alongside the planner and the writers instead of after them.
  const resourcesJob = startJob("resources", onProgress, () =>
    buildResourcesBlock({ ctx, blueprint: lesson, deps: deps?.resources }),
  );
  const downloadsJob: Promise<DownloadsResult | null> =
    blueprint.kind === "setup"
      ? startJob("downloads", onProgress, () =>
          buildDownloadsBlock({ ctx, blueprint: blueprint.bp, deps: deps?.downloads ?? deps?.resources }),
        )
      : Promise.resolve(null);

  onProgress?.({ stage: "planning" });
  const plan = await runOutlinePlanner(ctx, blueprint, deps?.planner);
  onProgress?.({
    stage: "planned",
    topics: plan.topics.length,
    sections: plan.topics.reduce((n, t) => n + t.sections.length, 0),
  });

  const total = plan.topics.length;
  const written = await Promise.all(
    plan.topics.map(async (topic, index) => {
      onProgress?.({ stage: "topic", status: "start", index, total, title: topic.title });
      try {
        return await runSectionWriter(ctx, plan, index, blueprint, deps?.worker);
      } catch (error) {
        console.warn(`[lecture-maker] topic ${index + 1} ("${topic.title}") failed:`, error instanceof Error ? error.message : error);
        return error instanceof Error ? error : new Error(String(error));
      } finally {
        onProgress?.({ stage: "topic", status: "done", index, total, title: topic.title });
      }
    }),
  );

  const kept = keepWrittenTopics(plan, written);

  const quizJob =
    blueprint.kind === "concept"
      ? (async () => {
          onProgress?.({ stage: "quiz", status: "start" });
          try {
            const questions = await runQuizWriter(
              ctx,
              plan.title,
              kept.map((k) => k.outline),
              kept.flatMap((k) => k.sections.map((s) => ({ title: s.title, goal: s.tutor.goal }))),
              blueprint.bp,
              deps?.worker,
            );
            onProgress?.({ stage: "quiz", status: "done" });
            return questions;
          } catch (error) {
            onProgress?.({ stage: "quiz", status: "skipped" });
            console.warn("[lecture-maker] quiz failed:", error instanceof Error ? error.message : error);
            return null;
          }
        })()
      : Promise.resolve(null);

  const [quiz, resources, downloads] = await Promise.all([quizJob, resourcesJob, downloadsJob]);
  onProgress?.({ stage: "assembling" });

  return assemble(ctx, kind, plan.title, kept, { quiz, resources, downloads });
}

type WrittenTopic = { outline: OutlineItem; sections: SectionEmissionItem[] };

/**
 * Drops topics whose writer failed every attempt, so one bad topic costs its
 * own section rather than the lecture. Fewer than two surviving topics is not
 * a lecture, and the original error is rethrown.
 */
function keepWrittenTopics(plan: LectureOutline, written: (SectionEmissionItem[] | Error)[]): WrittenTopic[] {
  const kept: WrittenTopic[] = [];
  plan.topics.forEach((t, i) => {
    const r = written[i];
    if (Array.isArray(r)) kept.push({ outline: { id: i + 1, title: t.title, duration: t.duration }, sections: r });
  });
  if (kept.length < 2) {
    const first = written.find((r): r is Error => r instanceof Error);
    throw first ?? new ApiError(502, "Lecture generation failed.");
  }
  return kept;
}

function startJob<T extends { block: { links: unknown[] } }>(
  stage: "resources" | "downloads",
  onProgress: Progress | undefined,
  run: () => Promise<T | null>,
): Promise<T | null> {
  if (!isResourcesEnabled()) return Promise.resolve(null);
  onProgress?.({ stage, status: "start" });
  return run()
    .catch(() => null)
    .then((r) => {
      onProgress?.({ stage, status: r ? "done" : "skipped", ...(r ? { links: r.block.links.length } : {}) });
      return r;
    });
}

/**
 * Final ids are assigned here, never trusted from a model: sections `s1…`,
 * blocks `b1…`. The quiz closes the last topic as its own section; downloads
 * open the first install topic; resources become a closing topic.
 */
function assemble(
  ctx: LessonContext,
  kind: LessonKind,
  title: string,
  topics: WrittenTopic[],
  extra: {
    quiz: Awaited<ReturnType<typeof runQuizWriter>> | null;
    resources: ResourcesResult | null;
    downloads: DownloadsResult | null;
  },
): MadeLecture {
  let s = 0;
  let b = 0;
  const outline = topics.map((t) => t.outline);
  const sections: Section[] = [];
  const push = (topicId: number, title: string, kindOf: Section["kind"], blocks: Record<string, unknown>[], tutor?: Section["tutor"]) => {
    const id = `s${++s}`;
    sections.push({
      id,
      topicId,
      title,
      kind: kindOf,
      blocks: blocks.map((blk) => ({ ...blk, id: `b${++b}`, topicId, sectionId: id })) as Section["blocks"],
      ...(tutor ? { tutor } : {}),
    });
  };

  topics.forEach((t, i) => {
    if (i === 0 && extra.downloads) {
      const bn = (ctx.language ?? DEFAULT_LANGUAGE).startsWith("bn");
      push(t.outline.id, bn ? "ডাউনলোড" : "Downloads", "theory", [extra.downloads.block]);
    }
    for (const sec of t.sections) push(t.outline.id, sec.title, sec.kind, sec.blocks, sec.tutor);
  });

  if (extra.quiz && extra.quiz.length > 0) {
    const last = outline[outline.length - 1]!;
    push(last.id, quizTitle(ctx.language), "theory", [{ type: "quiz", questions: extra.quiz }]);
  }

  if (extra.resources) {
    const topicId = Math.max(...outline.map((o) => o.id)) + 1;
    outline.push({ id: topicId, title: extra.resources.topicTitle, duration: "1:00" });
    push(topicId, extra.resources.topicTitle, "theory", [extra.resources.block]);
  }

  const parsed = lectureV3Schema.safeParse({ title, outline, sections });
  if (!parsed.success) {
    console.error("[lecture-maker] assembled lecture failed validation:", parsed.error.issues.slice(0, 12));
    throw new ApiError(502, "Lecture assembly failed validation.");
  }
  return {
    title,
    language: ctx.language ?? DEFAULT_LANGUAGE,
    kind,
    outline: parsed.data.outline,
    sections: parsed.data.sections,
  };
}

function quizTitle(language: Language | undefined): string {
  return (language ?? DEFAULT_LANGUAGE).startsWith("bn") ? "বোঝাপড়া যাচাই" : "Check your understanding";
}

/**
 * The setup blueprint projected onto the concept-lane shape, for the resources
 * picker (reads scope/objectives) — pitfalls become misconceptions.
 */
function setupBlueprintAsLesson(bp: SetupBlueprint): LessonBlueprint {
  return {
    scope: bp.goal,
    objectives: bp.stages.map((st) => st.doesWhat).slice(0, 8),
    assumedKnowledge: bp.prerequisites.map((p) => p.requirement).slice(0, 6),
    concepts: bp.tools.map((t) => ({ name: t.name, why: t.whatItIs, hardBecause: t.whyThisOne })),
    examples: [{ name: "setup", scenario: bp.goal, teaches: "" }],
    misconceptions: bp.pitfalls.slice(0, 6).map((p) => ({ mistake: p.symptom, whatBreaks: p.cause })),
    visuals: [],
    outOfScope: bp.outOfScope,
    currency: bp.currency,
  };
}
