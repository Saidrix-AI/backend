import { isResourcesEnabled } from "../../config/env.js";
import { ApiError } from "../../utils/apiError.js";
import { DEFAULT_LANGUAGE, type Language } from "../../validation/language.js";
import { buildLessonBlueprint, buildSetupBlueprint, retrieveLessonGrounding } from "./analyze.js";
import { resolveLectureDeps, type LlmDeps } from "./call.js";
import { classifyLesson } from "./classify.js";
import { buildDownloadsBlock, type DownloadsResult } from "./downloads.js";
import { buildLecturePlan, buildSetupPlan } from "./planner.js";
import { buildResourcesBlock, type ResourcesResult } from "./resources.js";
import type { LessonContext } from "./prompt.js";
import {
  assembledLectureSchema,
  type EasyBlock,
  type LessonKind,
  type OutlineItem,
  type PlannedBlock,
  type SetupPlannedBlock,
} from "./schema.js";
import { runSetupTopicWorker, runSvgWorker, runTopicWorker, type SvgEmission } from "./workers.js";

/** How many svg workers may be in flight at once. */
const SVG_CONCURRENCY = 4;

export type { LessonContext } from "./prompt.js";

/** Per-role deps injection seam — tests pass fake clients here. */
export interface LectureDeps {
  classifier?: LlmDeps;
  analyst?: LlmDeps;
  planner?: LlmDeps;
  worker?: LlmDeps;
  svg?: LlmDeps;
  resources?: LlmDeps;
  downloads?: LlmDeps;
}

export interface MadeLecture {
  title: string;
  /** Whatever the course was generated in — see validation/language.ts. */
  language: Language;
  /** Which lane produced it — persisted so the classroom can label a setup guide. */
  kind: LessonKind;
  outline: { id: number; title: string; duration: string }[];
  blocks: Record<string, unknown>[];
}

/**
 * Emitted as the pipeline progresses, so a caller (lecture.service.ts) can
 * relay real stages to the classroom's loading screen instead of a bare
 * spinner. Purely observational — nothing here changes what gets generated.
 */
export type LectureProgressEvent =
  | { stage: "analyzing" }
  | { stage: "classified"; kind: LessonKind }
  | { stage: "analyzed"; concepts: number; visuals: number }
  | { stage: "planning" }
  | { stage: "planned"; topics: number; easyBlocks: number; svgBlocks: number }
  | { stage: "topic"; status: "start" | "done"; index: number; total: number; title: string }
  | { stage: "svg"; status: "start" | "done" | "dropped"; index: number; total: number }
  | { stage: "downloads"; status: "start" | "done" | "skipped"; links?: number }
  | { stage: "resources"; status: "start" | "done" | "skipped"; links?: number }
  | { stage: "assembling" };

type Progress = (event: LectureProgressEvent) => void;

/**
 * Starts the closing further-reading section, deliberately NOT awaited: it needs
 * only the lesson and the analyst's scope, both of which exist by the time it is
 * called, so its two searches and its call run alongside the planner and the
 * writers instead of adding to a wait the student is watching.
 *
 * buildResourcesBlock's contract is that it never throws; the `.catch` enforces
 * it at the seam, because the Promise.all it feeds is the one place where a
 * rejection would take the whole lecture with it.
 */
function startResourcesJob(
  ctx: LessonContext,
  blueprint: Parameters<typeof buildResourcesBlock>[0]["blueprint"],
  deps: LectureDeps | undefined,
  onProgress?: Progress,
): Promise<ResourcesResult | null> {
  if (!isResourcesEnabled()) {
    // Emitting nothing at all when the feature is off keeps the progress
    // stream byte-identical to what it was before this existed.
    return Promise.resolve(null);
  }
  onProgress?.({ stage: "resources", status: "start" });
  return buildResourcesBlock({ ctx, blueprint, deps: deps?.resources })
    .catch(() => null)
    .then((r) => {
      onProgress?.({
        stage: "resources",
        status: r ? "done" : "skipped",
        ...(r ? { links: r.block.links.length } : {}),
      });
      return r;
    });
}

/**
 * The concept lane: one analyst call (what does this lesson actually teach?) →
 * one planner call → parallel topic workers (easy blocks) + svg workers (one
 * call per diagram) → deterministic assembly in plan order with final ids
 * assigned here (planner/worker ids are never trusted) → full document
 * validation. No organizer LLM — assembly is plain code.
 *
 * The setup lane (makeSetupLecture below) has the same shape and a different
 * arc; makeLecture routes between them.
 */
export async function makeLecture(
  ctx: LessonContext,
  deps?: LectureDeps,
  onProgress?: Progress,
): Promise<MadeLecture> {
  onProgress?.({ stage: "analyzing" });

  // The classifier must finish before we know which analyst to run, so it is
  // run ALONGSIDE the two retrievals the analyst needs anyway — the routing
  // decision costs no wall clock at all.
  const [kind, { grounding, freshness }] = await Promise.all([
    classifyLesson(ctx, deps?.classifier),
    retrieveLessonGrounding(ctx),
  ]);
  onProgress?.({ stage: "classified", kind });

  if (kind === "setup") {
    return makeSetupLecture(ctx, grounding, freshness, deps, onProgress);
  }

  const analystDeps = deps?.analyst ?? resolveLectureDeps("analyst");
  const plannerDeps = deps?.planner ?? resolveLectureDeps("planner");
  const workerDeps = deps?.worker ?? resolveLectureDeps("worker");
  const svgDeps = deps?.svg ?? resolveLectureDeps("svg");

  // Read the lesson before shaping it. Every later call works from this one
  // reading, which is also what keeps the parallel topic writers consistent.
  const blueprint = await buildLessonBlueprint(ctx, grounding, freshness, analystDeps);
  onProgress?.({
    stage: "analyzed",
    concepts: blueprint.concepts.length,
    visuals: blueprint.visuals.length,
  });

  const resourcesJob = startResourcesJob(ctx, blueprint, deps, onProgress);

  onProgress?.({ stage: "planning" });
  const plan = await buildLecturePlan(ctx, blueprint, plannerDeps);

  // Group the plan: easy blocks per topic (plan order) and svg blocks (plan order).
  const easyByTopic = new Map<number, PlannedBlock[]>();
  const svgPlanned: PlannedBlock[] = [];
  for (const b of plan.blocks) {
    if (b.type === "svg") {
      svgPlanned.push(b);
    } else {
      const list = easyByTopic.get(b.topicId) ?? [];
      list.push(b);
      easyByTopic.set(b.topicId, list);
    }
  }

  const topicById = new Map(plan.outline.map((t) => [t.id, t]));
  onProgress?.({
    stage: "planned",
    topics: easyByTopic.size,
    easyBlocks: plan.blocks.length - svgPlanned.length,
    svgBlocks: svgPlanned.length,
  });

  // Topic worker failures propagate (502 — never cache a partial lecture);
  // svg workers resolve to null on failure (block dropped, lecture ships).
  const topicTotal = easyByTopic.size;
  const topicJobs = [...easyByTopic.entries()].map(async ([topicId, planned], index) => {
    const topic = topicById.get(topicId)!; // plan superRefine guarantees membership
    onProgress?.({ stage: "topic", status: "start", index, total: topicTotal, title: topic.title });
    const blocks = await runTopicWorker(
      ctx,
      plan.title,
      { id: topic.id, title: topic.title },
      planned,
      blueprint,
      plan.outline,
      workerDeps,
    );
    onProgress?.({ stage: "topic", status: "done", index, total: topicTotal, title: topic.title });
    return [topicId, blocks] as const;
  });

  // A visual-heavy lecture can plan a dozen svgs. Firing them all at once on
  // the strong svg model invites rate limiting, so they go a few at a time.
  const svgTotal = svgPlanned.length;
  const runSvgBatched = async () => {
    const out: (SvgEmission | null)[] = [];
    for (let i = 0; i < svgPlanned.length; i += SVG_CONCURRENCY) {
      const batch = svgPlanned.slice(i, i + SVG_CONCURRENCY).map((planned, j) => {
        const index = i + j;
        onProgress?.({ stage: "svg", status: "start", index, total: svgTotal });
        return runSvgWorker(
          ctx,
          plan.title,
          topicById.get(planned.topicId)?.title ?? "",
          planned,
          `s${index + 1}-`,
          svgDeps,
        ).then((res) => {
          onProgress?.({ stage: "svg", status: res ? "done" : "dropped", index, total: svgTotal });
          return res;
        });
      });
      out.push(...(await Promise.all(batch)));
    }
    return out;
  };

  const [topicResults, svgResults, resources] = await Promise.all([
    Promise.all(topicJobs),
    runSvgBatched(),
    resourcesJob,
  ]);

  onProgress?.({ stage: "assembling" });

  const queues = new Map<number, EasyBlock[]>(topicResults.map(([id, blocks]) => [id, [...blocks]]));
  const svgQueue = [...svgResults];

  // Assembly: walk the plan in order, pulling each block from its queue and
  // assigning final sequential ids.
  const blocks: Record<string, unknown>[] = [];
  let n = 0;
  for (const planned of plan.blocks) {
    if (planned.type === "svg") {
      const emission = svgQueue.shift();
      if (!emission) continue; // already warned in runSvgWorker
      blocks.push({
        id: `b${++n}`,
        type: "svg",
        topicId: planned.topicId,
        svg: emission.svg,
        alt: emission.alt,
        ...(emission.caption ? { caption: emission.caption } : {}),
      });
    } else {
      const block = queues.get(planned.topicId)?.shift();
      if (!block) {
        // Unreachable given the worker count check; never crash assembly on it.
        console.warn(`[lecture-maker] missing worker block for plan entry "${planned.brief.slice(0, 60)}"`);
        continue;
      }
      blocks.push({ ...block, id: `b${++n}`, topicId: planned.topicId });
    }
  }

  const { outline, blocks: withResources } = appendResources(plan.outline, blocks, resources, n);
  return finish(ctx, plan.title, "concept", outline, withResources);
}

/**
 * The setup lane: same pipeline shape, different arc. The guide is planned
 * around getting software running rather than around understanding an idea, so
 * there is no quiz and no svg — instead there is exactly one `downloads` block,
 * built from verified search results the way `resources` is, and a closing
 * verification checklist.
 *
 * `grounding` and `freshness` are handed in already retrieved: makeLecture had
 * to fetch them before it could know which lane this is.
 */
async function makeSetupLecture(
  ctx: LessonContext,
  grounding: string,
  freshness: string,
  deps?: LectureDeps,
  onProgress?: Progress,
): Promise<MadeLecture> {
  const analystDeps = deps?.analyst ?? resolveLectureDeps("analyst");
  const plannerDeps = deps?.planner ?? resolveLectureDeps("planner");
  const workerDeps = deps?.worker ?? resolveLectureDeps("worker");

  const blueprint = await buildSetupBlueprint(ctx, grounding, freshness, analystDeps);
  // `concepts` carries the stage count here — the event shape is shared with the
  // concept lane so the classroom's loading screen needs no second case.
  onProgress?.({
    stage: "analyzed",
    concepts: blueprint.stages.length,
    visuals: blueprint.visuals.length,
  });

  // Both link sections start now and are awaited with the writers, exactly like
  // the concept lane's resources job. The downloads search is the one the
  // student is actually waiting on, so it must not be serialised after them.
  // Emitting nothing when the search feature is off keeps the progress stream
  // free of a stage that was never going to happen, same as the concept lane.
  const downloadsJob: Promise<DownloadsResult | null> = isResourcesEnabled()
    ? (onProgress?.({ stage: "downloads", status: "start" }),
      buildDownloadsBlock({ ctx, blueprint, deps: deps?.downloads ?? deps?.resources })
        .catch(() => null)
        .then((r) => {
          onProgress?.({
            stage: "downloads",
            status: r ? "done" : "skipped",
            ...(r ? { links: r.block.links.length } : {}),
          });
          return r;
        }))
    : Promise.resolve(null);
  const resourcesJob = startResourcesJob(ctx, toResourcesBlueprint(blueprint), deps, onProgress);

  onProgress?.({ stage: "planning" });
  const plan = await buildSetupPlan(ctx, blueprint, plannerDeps);

  // Everything except the downloads block is written by a topic worker; the
  // downloads entry is a placeholder the server fills, the way an svg entry is.
  const easyByTopic = new Map<number, SetupPlannedBlock[]>();
  for (const b of plan.blocks) {
    if (b.type === "downloads") continue;
    const list = easyByTopic.get(b.topicId) ?? [];
    list.push(b);
    easyByTopic.set(b.topicId, list);
  }

  const topicById = new Map(plan.outline.map((t) => [t.id, t]));
  onProgress?.({
    stage: "planned",
    topics: easyByTopic.size,
    easyBlocks: plan.blocks.length - 1,
    svgBlocks: 0,
  });

  const topicTotal = easyByTopic.size;
  const topicJobs = [...easyByTopic.entries()].map(async ([topicId, planned], index) => {
    const topic = topicById.get(topicId)!; // plan superRefine guarantees membership
    onProgress?.({ stage: "topic", status: "start", index, total: topicTotal, title: topic.title });
    const blocks = await runSetupTopicWorker(
      ctx,
      plan.title,
      { id: topic.id, title: topic.title },
      planned,
      blueprint,
      plan.outline,
      workerDeps,
    );
    onProgress?.({ stage: "topic", status: "done", index, total: topicTotal, title: topic.title });
    return [topicId, blocks] as const;
  });

  const [topicResults, downloads, resources] = await Promise.all([
    Promise.all(topicJobs),
    downloadsJob,
    resourcesJob,
  ]);

  onProgress?.({ stage: "assembling" });

  const queues = new Map<number, EasyBlock[]>(topicResults.map(([id, blocks]) => [id, [...blocks]]));

  const blocks: Record<string, unknown>[] = [];
  let n = 0;
  for (const planned of plan.blocks) {
    if (planned.type === "downloads") {
      // A failed search drops the section rather than the guide. The steps that
      // follow still tell the student what to install; they just have to find
      // the page themselves, which beats being sent to an invented address.
      if (!downloads) {
        console.warn(`[lecture-maker] no downloads section for "${ctx.topicTitle}" — entry skipped`);
        continue;
      }
      blocks.push({ ...downloads.block, id: `b${++n}`, topicId: planned.topicId });
      continue;
    }
    const block = queues.get(planned.topicId)?.shift();
    if (!block) {
      console.warn(`[lecture-maker] missing worker block for plan entry "${planned.brief.slice(0, 60)}"`);
      continue;
    }
    blocks.push({ ...block, id: `b${++n}`, topicId: planned.topicId });
  }

  const { outline, blocks: withResources } = appendResources(plan.outline, blocks, resources, n);
  return finish(ctx, plan.title, "setup", outline, withResources);
}

/**
 * The setup blueprint seen through the resources picker's eyes. That picker only
 * reads `scope` and `objectives`, so rather than teaching it a second shape the
 * setup blueprint is projected onto the one it already knows.
 */
function toResourcesBlueprint(
  bp: Awaited<ReturnType<typeof buildSetupBlueprint>>,
): Parameters<typeof buildResourcesBlock>[0]["blueprint"] {
  return {
    scope: bp.goal,
    objectives: bp.stages.map((s) => s.doesWhat).slice(0, 8),
    assumedKnowledge: [],
    concepts: bp.tools.map((t) => ({ name: t.name, why: t.whatItIs, hardBecause: "" })),
    examples: [{ name: "setup", scenario: bp.goal, teaches: "" }],
    misconceptions: [],
    visuals: [],
    outOfScope: bp.outOfScope,
    currency: bp.currency,
  };
}

/**
 * The Resources section closes the lecture, after the quiz (concept lane) or
 * after the checklist (setup lane). It gets its own outline topic so the
 * classroom shows it as a section of its own — with an id derived from the
 * highest existing one, not from the length: nothing requires the planner's ids
 * to be contiguous, and `length + 1` would collide with an existing topic on an
 * outline numbered 1, 2, 3, 5.
 */
function appendResources(
  outline: OutlineItem[],
  blocks: Record<string, unknown>[],
  resources: ResourcesResult | null,
  lastBlockNumber: number,
): { outline: OutlineItem[]; blocks: Record<string, unknown>[] } {
  if (!resources) return { outline, blocks };
  const topicId = Math.max(...outline.map((t) => t.id)) + 1;
  return {
    outline: [...outline, { id: topicId, title: resources.topicTitle, duration: "1:00" }],
    blocks: [...blocks, { ...resources.block, id: `b${lastBlockNumber + 1}`, topicId }],
  };
}

/** Whole-document validation, shared by both lanes. A failure here is a pipeline bug. */
function finish(
  ctx: LessonContext,
  title: string,
  kind: LessonKind,
  outline: OutlineItem[],
  blocks: Record<string, unknown>[],
): MadeLecture {
  const parsed = assembledLectureSchema.safeParse({ title, outline, blocks });
  if (!parsed.success) {
    console.error("[lecture-maker] assembled lecture failed validation:", parsed.error.issues.slice(0, 12));
    throw new ApiError(502, "Lecture assembly failed validation.");
  }
  return {
    title,
    language: ctx.language ?? DEFAULT_LANGUAGE,
    kind,
    outline,
    blocks: parsed.data.blocks as MadeLecture["blocks"],
  };
}
