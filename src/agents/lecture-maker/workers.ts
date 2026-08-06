import { env } from "../../config/env.js";
import { formatZodIssues, resolveLectureDeps, runForcedToolCall, type LlmDeps } from "./call.js";
import {
  buildSetupWorkerSystemPrompt,
  buildSetupWorkerUserMessage,
  buildSvgWorkerSystemPrompt,
  buildSvgWorkerUserMessage,
  buildTopicWorkerSystemPrompt,
  buildTopicWorkerUserMessage,
  type LessonContext,
} from "./prompt.js";
import {
  emitSetupBlocksTool,
  emitSvgBlockTool,
  emitTopicBlocksTool,
  svgEmissionSchema,
  topicBlocksEmissionSchema,
  type AnyPlannedBlock,
  type EasyBlock,
  type LessonBlueprint,
  type OutlineItem,
  type PlannedBlock,
  type SetupBlueprint,
  type SetupPlannedBlock,
} from "./schema.js";
import { inspectSvg } from "./browser.js";
import { checkMermaidBlocks } from "./mermaid.js";
import { fixSvg } from "./fixSvg.js";
import { validateSvgGeometry, validateSvgPalette } from "./geometry.js";
import { inlineSvgStyles } from "./inlineStyles.js";
import { measureByMetrics } from "./measureByMetrics.js";
import { validateSvgMarkup } from "./validate.js";
import { critiqueDiagram } from "./visionCritic.js";

/**
 * Fills in a `type` the model left off, from the plan entry at the same
 * position. Only applies when the emission has the planned number of blocks —
 * otherwise the positions do not line up and guessing would mislabel content.
 * Exported for testing.
 */
export function backfillMissingTypes(raw: unknown, planned: AnyPlannedBlock[]): void {
  const blocks = (raw as { blocks?: unknown })?.blocks;
  if (!Array.isArray(blocks) || blocks.length !== planned.length) return;
  blocks.forEach((block, i) => {
    if (block && typeof block === "object" && !("type" in block)) {
      (block as { type?: string }).type = planned[i]!.type;
    }
  });
}

/**
 * Writes the final easy blocks for one outline topic. The planned list is the
 * authoritative skeleton: the worker must emit the same count in the same
 * order (enforced; mismatch burns the repair round, second failure → 502).
 * `topicId` is forced onto every block — the model is not trusted with it.
 *
 * `blueprint` and `outline` are what stop the parallel writers drifting apart:
 * one shared list of worked examples so they all build the same one, and the
 * full outline so nobody re-teaches a neighbour's topic.
 */
export async function runTopicWorker(
  ctx: LessonContext,
  lectureTitle: string,
  topic: { id: number; title: string },
  planned: PlannedBlock[],
  blueprint: LessonBlueprint,
  outline: OutlineItem[],
  deps?: LlmDeps,
): Promise<EasyBlock[]> {
  const blocks = await runForcedToolCall({
    deps: deps ?? resolveLectureDeps("worker"),
    tool: emitTopicBlocksTool,
    system: buildTopicWorkerSystemPrompt(),
    user: buildTopicWorkerUserMessage(ctx, lectureTitle, topic, planned, blueprint, outline),
    parse: async (raw) => {
      // A topic worker that fails both attempts sinks the whole lecture with a
      // bare 502, so each rejection is logged — otherwise the only signal is
      // "invalid emit_topic_blocks structure", which names no cause.
      const reject = (issues: string) => {
        console.warn(`[lecture-maker] topic ${topic.id} ("${topic.title}") rejected: ${issues}`);
        return { success: false as const, issues };
      };
      // The model drops `type` on maybe one block in three when the brief makes
      // it obvious (a topic planned as a lone quiz is the usual victim), which
      // burned a repair round on most lectures. The plan already states every
      // type, so fill in only what is MISSING — a type the model actually chose
      // is left alone, since substituting a block type is allowed.
      backfillMissingTypes(raw, planned);

      const r = topicBlocksEmissionSchema.safeParse(raw);
      if (!r.success) return reject(formatZodIssues(r.error));
      if (r.data.blocks.length !== planned.length) {
        return reject(`expected exactly ${planned.length} blocks in the planned order, got ${r.data.blocks.length}`);
      }
      // Mermaid renders in the browser, so a syntax error would ship to the
      // student as an error card. Catch it here and send it back for repair.
      const mermaidIssue = await checkMermaidBlocks(r.data.blocks);
      if (mermaidIssue) return reject(mermaidIssue);
      return { success: true, data: r.data.blocks };
    },
    // Only fires when the output actually truncated. Trimming the longest
    // block beats "keep every block short", which used to suppress depth on
    // every call whether or not there was a token problem.
    sizeHint: "Shorten only the longest block; still emit exactly the planned number of blocks.",
  });
  return blocks.map((b) => ({ ...b, topicId: topic.id }));
}

/**
 * Writes the final blocks for one STAGE of a setup guide. Same contract as
 * runTopicWorker — planned count and order are authoritative, topicId is forced
 * — but a different tool and a different prompt: the writer here is producing
 * install steps, commands with their expected output, a troubleshooting table
 * and the closing checklist, and it is given no way to emit a quiz or a url.
 */
export async function runSetupTopicWorker(
  ctx: LessonContext,
  guideTitle: string,
  topic: { id: number; title: string },
  planned: SetupPlannedBlock[],
  blueprint: SetupBlueprint,
  outline: OutlineItem[],
  deps?: LlmDeps,
): Promise<EasyBlock[]> {
  const blocks = await runForcedToolCall({
    deps: deps ?? resolveLectureDeps("worker"),
    tool: emitSetupBlocksTool,
    system: buildSetupWorkerSystemPrompt(),
    user: buildSetupWorkerUserMessage(ctx, guideTitle, topic, planned, blueprint, outline),
    parse: async (raw) => {
      const reject = (issues: string) => {
        console.warn(`[lecture-maker] setup stage ${topic.id} ("${topic.title}") rejected: ${issues}`);
        return { success: false as const, issues };
      };
      backfillMissingTypes(raw, planned);

      const r = topicBlocksEmissionSchema.safeParse(raw);
      if (!r.success) return reject(formatZodIssues(r.error));
      if (r.data.blocks.length !== planned.length) {
        return reject(`expected exactly ${planned.length} blocks in the planned order, got ${r.data.blocks.length}`);
      }
      const mermaidIssue = await checkMermaidBlocks(r.data.blocks);
      if (mermaidIssue) return reject(mermaidIssue);
      return { success: true, data: r.data.blocks };
    },
    sizeHint: "Shorten only the longest block; still emit exactly the planned number of blocks.",
  });
  return blocks.map((b) => ({ ...b, topicId: topic.id }));
}

export interface SvgEmission {
  svg: string;
  alt: string;
  caption?: string;
}

/**
 * Draws one svg block. Unlike the other calls, a final failure returns null
 * instead of throwing — a dropped diagram must never sink the whole lecture.
 *
 * Two tiers of check. Safety and well-formedness are absolute: markup that
 * fails them is never kept. Legibility and palette only *drive the repair
 * round* — if the second attempt is still imperfect the drawing is kept anyway,
 * because a slightly untidy diagram teaches far more than a missing one. (Held
 * to the same bar as the hard checks, five of seven drawings were lost.)
 */
export async function runSvgWorker(
  ctx: LessonContext,
  lectureTitle: string,
  topicTitle: string,
  planned: PlannedBlock,
  idPrefix: string,
  deps?: LlmDeps,
): Promise<SvgEmission | null> {
  // Best attempt that was safe and well-formed but not perfectly legible.
  let fallback: { emission: SvgEmission; issues: string[] } | null = null;

  try {
    return await runForcedToolCall({
      deps: deps ?? resolveLectureDeps("svg"),
      tool: emitSvgBlockTool,
      system: buildSvgWorkerSystemPrompt(),
      user: buildSvgWorkerUserMessage(ctx, lectureTitle, topicTitle, planned, idPrefix),
      parse: async (raw) => {
        const r = svgEmissionSchema.safeParse(raw);
        if (!r.success) return { success: false, issues: formatZodIssues(r.error) };
        // Fold any <style> block into inline attributes before validating —
        // models reach for CSS classes constantly, and rejecting the drawing
        // over that throws away a finished (expensive) diagram.
        const inlined = inlineSvgStyles(r.data.svg).svg;
        // Safety and well-formedness first — a malformed drawing can't be
        // rendered, measured or repaired. Legibility comes after it parses.
        const svgIssues = validateSvgMarkup(inlined);
        if (svgIssues.length > 0) return { success: false, issues: svgIssues.slice(0, 12).join("; ") };

        // Render it. This is what makes every check below true rather than
        // approximate: a browser knows what a glyph measures and where a
        // transformed group lands, and the same render supplies the picture the
        // vision critic reviews. A null here means Chromium was unavailable, and
        // everything downstream falls back to estimated geometry.
        const wantShot = env.LECTURE_SVG_VISION_ENABLED;
        let inspection = await inspectSvg(inlined, { screenshot: wantShot });

        // Repair the coordinate mistakes in code. A cheap model cannot act on a
        // prose description of them, so the repair round only ever sees what
        // deterministic fixing could not solve.
        const fixed = fixSvg(inlined, { alt: r.data.alt, measurement: inspection?.measurement });
        if (fixed.repairs.length > 0) {
          console.debug(
            `[lecture-maker] auto-fixed svg (${fixed.repairs.length}): ${fixed.repairs.slice(0, 3).join("; ")}`,
          );
          // The repairs moved things, so the earlier measurement now describes a
          // drawing that no longer exists. Judge what will actually be shown.
          inspection = (await inspectSvg(fixed.svg, { screenshot: wantShot })) ?? inspection;
        }
        const svg = fixed.svg;
        const measurement = inspection?.measurement ?? measureByMetrics(svg);

        const emission = { ...r.data, svg };
        const readability = [
          ...validateSvgGeometry(svg, { idPrefix, alt: r.data.alt, measurement }),
          ...validateSvgPalette(svg),
        ];

        // The critic only sees drawings that already measure clean. Overlap is
        // arithmetic — exact, free and deterministic — so paying a vision model
        // to re-find it would be slower, dearer and less reliable. It is spent
        // on what arithmetic cannot judge.
        if (readability.length === 0 && inspection?.png) {
          readability.push(
            ...(await critiqueDiagram(inspection.png, { brief: planned.brief, alt: r.data.alt })),
          );
        }

        if (readability.length > 0) {
          // Keep the tidiest attempt seen so far, then ask for a fix.
          if (!fallback || readability.length < fallback.issues.length) {
            fallback = { emission, issues: readability };
          }
          return { success: false, issues: readability.slice(0, 8).join("; ") };
        }
        return { success: true, data: emission };
      },
      sizeHint:
        "Draw a much simpler diagram: fewer shapes, fewer labels, and summarise rather than enumerate every item.",
      // Own budget and clock — the svg worker is the slowest, largest call in
      // the pipeline and the only one a cheap model runs away on.
      maxTokens: env.LECTURE_SVG_MAX_OUTPUT_TOKENS,
      timeoutMs: env.LECTURE_SVG_TIMEOUT_MS,
      // More rounds than the other agents get. Their repair feedback is "your
      // JSON was malformed", which a model either fixes at once or never; this
      // one hands back measured coordinates and a rendered critique, which is
      // worth another attempt.
      maxAttempts: env.LECTURE_SVG_REPAIR_ROUNDS,
    });
  } catch (err) {
    if (fallback) {
      const kept = fallback as { emission: SvgEmission; issues: string[] };
      console.warn(
        `[lecture-maker] svg kept with ${kept.issues.length} legibility issue(s) ("${planned.brief.slice(0, 50)}"): ${kept.issues[0]}`,
      );
      return kept.emission;
    }
    console.warn(
      `[lecture-maker] svg block dropped ("${planned.brief.slice(0, 60)}"):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
