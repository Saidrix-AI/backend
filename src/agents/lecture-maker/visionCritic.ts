import { HumanMessage, SystemMessage, type AIMessage } from "@langchain/core/messages";
import type OpenAI from "openai";

import { env } from "../../config/env.js";
import { getChatModelFor } from "../llm.js";
import { svgDefaultModel } from "./call.js";
import { gatedLlmCall } from "../shared/llmGate.js";
import { recordUsage } from "../shared/tokenLedger.js";

/**
 * Shows the rendered drawing to a vision model and asks what is wrong with it.
 *
 * This is the layer that judges what arithmetic cannot. The geometry rules can
 * prove two boxes overlap; they cannot tell that a diagram reads as a muddle,
 * that an arrow points at nothing, or that a label is technically inside its
 * box but visually collides with the shape behind it. So the critic runs on the
 * picture, after the measurable defects are already gone.
 *
 * Two deliberate limits:
 *
 * - It only ever runs on drawings the geometry pass considers clean. Overlap is
 *   a numeric fact and measuring it is exact, free and deterministic; paying a
 *   vision model to re-detect it would be slower, dearer and less reliable.
 * - The prompt refuses it any opinion on style. An unconstrained critic finds
 *   something to improve in every drawing, and since every issue costs a repair
 *   round, that turns into rewriting good diagrams until the attempts run out.
 *
 * Advisory throughout: any failure returns "no issues" rather than throwing, so
 * a critic that is slow, unavailable or confused can never cost a lecture its
 * diagram.
 */

const REVIEW_TOOL: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "report_diagram_review",
    description: "Report whether the rendered diagram is legible. Call exactly once.",
    parameters: {
      type: "object",
      required: ["ok", "issues"],
      properties: {
        ok: {
          type: "boolean",
          description: "True when the diagram is legible and nothing needs changing.",
        },
        issues: {
          type: "array",
          items: { type: "string" },
          description:
            "One sentence per defect, naming the element and the fix. Empty when ok is true. Never more than three.",
        },
      },
    },
  },
};

const SYSTEM = `You are reviewing a rendered diagram from a programming lecture for legibility only.

Report ONLY these, and only when clearly visible in the image:
- text overlapping other text, or text overlapping a shape so either becomes hard to read
- text cut off by the edge of a shape or the edge of the canvas
- text too small or too low-contrast to read at normal size
- an arrow or connector that starts or ends nowhere, or points at the wrong element
- a large empty region that leaves the drawing visibly lopsided

Never report:
- colour choices, palette, styling, spacing preferences, or anything you would call "could be improved"
- the teaching content, the wording of labels, or whether the diagram is the best way to explain the topic
- anything you are not certain you can actually see in the image

Most diagrams you see are fine. If nothing in the list above is clearly wrong, set ok true and return an
empty issues array. Be strict about that: a false alarm costs a correct diagram a needless rewrite.

When something is wrong, write each issue as one sentence naming the element and the fix, e.g.
'the label "Opening tag" overlaps the box border below it — move it up about 10 units'.`;

export interface CritiqueContext {
  /** What the diagram was asked to show, so "points at nothing" is judgeable. */
  brief: string;
  /** The emission's alt text: what the drawing claims to depict. */
  alt: string;
}

interface ReviewPayload {
  ok?: unknown;
  issues?: unknown;
}

/** At most this many critic sentences reach the repair round. */
const MAX_ISSUES = 3;

/**
 * Latched when the configured model turns out not to accept images.
 *
 * That failure is permanent, not transient: OpenRouter answers
 * "404 No endpoints found that support image input" and will keep doing so.
 * Without this every diagram in every lecture pays for a doomed call and logs
 * the same warning — which is how a misconfigured model stays invisible
 * (the critic returns "no issues", so the pipeline looks like it is working).
 */
let imageUnsupported = false;

function isCapabilityError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /image input|does not support image|no endpoints found|vision/i.test(message);
}

/**
 * Reviews one rendered diagram. Returns the defects found, empty when the
 * drawing is fine *or* when the critic could not run.
 */
export async function critiqueDiagram(png: Buffer, ctx: CritiqueContext): Promise<string[]> {
  if (!env.LECTURE_SVG_VISION_ENABLED || imageUnsupported) return [];

  const model = env.LECTURE_SVG_VISION_MODEL ?? env.LECTURE_SVG_MODEL ?? svgDefaultModel(env.LLM_PROVIDER);
  // The critic writes at most three short sentences; anything more is a model
  // that has started redesigning the drawing.
  const chat = getChatModelFor(model, 400);
  if (!chat) return [];

  try {
    // The only LLM call in the pipeline that does not go through
    // runForcedToolCall, so it needs the provider throttle applied by hand.
    const reply = (await gatedLlmCall(() =>
      chat
        .bindTools([REVIEW_TOOL], {
          tool_choice: { type: "function", function: { name: REVIEW_TOOL.function.name } },
        })
        .invoke(
          [
            new SystemMessage(SYSTEM),
            new HumanMessage({
              content: [
                {
                  type: "text",
                  text: `This diagram was drawn to show: ${ctx.brief}\nIts description reads: ${ctx.alt}\n\nReview the image.`,
                },
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${png.toString("base64")}` },
                },
              ],
            }),
          ],
          { options: { timeout: env.LECTURE_SVG_RENDER_TIMEOUT_MS * 2, maxRetries: 0 } },
        ),
    )) as AIMessage;
    recordUsage("vision_critic", model, reply);

    const call = reply.tool_calls?.[0];
    if (!call) return [];
    const payload = call.args as ReviewPayload;
    if (payload.ok === true) return [];
    if (!Array.isArray(payload.issues)) return [];

    return payload.issues
      .filter((i): i is string => typeof i === "string" && i.trim().length > 0)
      .map((i) => i.trim())
      .slice(0, MAX_ISSUES);
  } catch (err) {
    // A critic that cannot run is not a reason to lose a finished diagram.
    if (isCapabilityError(err)) {
      imageUnsupported = true;
      console.warn(
        `[lecture-maker] "${model}" cannot accept images, so diagram vision review is now OFF for this process. ` +
          `Set LECTURE_SVG_VISION_MODEL to a vision-capable model (e.g. anthropic/claude-sonnet-5), ` +
          `or LECTURE_SVG_VISION_ENABLED=false to stop trying.`,
      );
    } else {
      console.warn(
        `[lecture-maker] vision review skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return [];
  }
}
