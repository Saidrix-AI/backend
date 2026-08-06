import type OpenAI from "openai";
import { env } from "../../config/env.js";
import { ApiError } from "../../utils/apiError.js";
import { getOpenAICompatClient, reasoningParams } from "../llm.js";
import { retrieveGroundingDetailed } from "../../rag/retriever.js";
import { retrieveFreshness } from "../shared/freshness.js";
import { buildCourseMakerSystemPrompt, buildCourseMakerUserMessage } from "./prompt.js";
import { emitCourseTool, generatedCourseSchema, type CourseBrief, type GeneratedCourse } from "./schema.js";

/** The LLM boundary — tests mock this module (or inject a fake client). */
export interface GeneratorDeps {
  client: OpenAI;
  model: string;
}

export function resolveGeneratorDeps(): GeneratorDeps {
  const oai = getOpenAICompatClient();
  if (!oai) {
    throw new ApiError(503, "Course generation needs an OpenAI-compatible LLM provider (openai or openrouter).");
  }
  return { client: oai.client, model: env.COURSE_MAKER_MODEL ?? oai.model };
}

// Env-driven so slow reasoning models (e.g. glm-5.2) don't time out.
const INITIAL_TIMEOUT_MS = env.LLM_TIMEOUT_MS;
const REPAIR_TIMEOUT_MS = Math.round(env.LLM_TIMEOUT_MS * 0.75);
const MAX_ISSUES_IN_REPAIR = 12;

type Choice = OpenAI.Chat.ChatCompletion.Choice | undefined;
type Extraction = { payload: GeneratedCourse } | { issue: string };

/**
 * One forced `emit_course` call, with a single repair round-trip covering the
 * three failure shapes: no/ignored tool call, truncated output, invalid structure.
 */
export async function generateCoursePayload(
  brief: CourseBrief,
  existingTitles: string[],
  deps?: GeneratorDeps,
): Promise<GeneratedCourse> {
  const { client, model } = deps ?? resolveGeneratorDeps();
  // Ground the outline in our own curriculum when RAG is configured (best-effort:
  // empty string when disabled or no match, so behavior is unchanged otherwise).
  const groundQuery = `${brief.objective} ${brief.titleHint ?? ""}`.trim();
  // Two independent lookups, so they run together: our curriculum (what to
  // teach and in what order) and the live web (what is current in this subject
  // today, which decides which chapters are still worth having at all).
  const [{ block: grounding, guides, count }, freshness] = await Promise.all([
    retrieveGroundingDetailed(groundQuery, { topK: 8 }),
    retrieveFreshness(brief.titleHint ?? brief.objective, {
      intent: "current version roadmap what to learn deprecated",
      label: "course-maker",
    }),
  ]);
  // eslint-disable-next-line no-console
  console.info(
    count > 0
      ? `[course-maker] outline grounded in knowledge base: ${count} chunks from ${guides.join(", ")}`
      : `[course-maker] outline: no knowledge-base grounding (RAG off or no match) for "${groundQuery.slice(0, 60)}"`,
  );
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildCourseMakerSystemPrompt(existingTitles) },
    { role: "user", content: buildCourseMakerUserMessage(brief, grounding, freshness) },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    const completion = await client.chat.completions.create(
      {
        model,
        messages,
        max_tokens: env.COURSE_MAX_OUTPUT_TOKENS,
        // gpt-5.x rejects function tools unless reasoning is off — see llm.ts.
        ...reasoningParams(model),
        tools: [emitCourseTool],
        tool_choice: { type: "function", function: { name: "emit_course" } },
      },
      { timeout: attempt === 0 ? INITIAL_TIMEOUT_MS : REPAIR_TIMEOUT_MS, maxRetries: 1 },
    );

    const choice: Choice = completion.choices?.[0];
    const result = extract(choice);
    if ("payload" in result) return result.payload;
    if (attempt === 0) messages.push(...repairMessages(choice, result.issue));
  }

  throw new ApiError(502, "Course generation failed: the model returned an invalid course structure.");
}

function extract(choice: Choice): Extraction {
  const call = choice?.message?.tool_calls?.[0];
  if (!call || call.type !== "function" || call.function.name !== "emit_course") {
    return { issue: "You must respond by calling the emit_course function — do not reply with plain text." };
  }
  if (choice?.finish_reason === "length") {
    // Shorten the prose, never the curriculum — dropping chapters to fit a
    // token budget is exactly what the per-chapter split exists to prevent.
    return {
      issue:
        "Your output was truncated. Keep every chapter, but cut each brief to two short sentences.",
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(call.function.arguments || "{}");
  } catch {
    return {
      issue: "The emit_course arguments were not valid JSON. Call emit_course again with valid JSON (a smaller course if needed).",
    };
  }
  const parsed = generatedCourseSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, MAX_ISSUES_IN_REPAIR)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { issue: `The course structure had problems: ${issues}. Call emit_course again with these fixed.` };
  }
  return { payload: parsed.data };
}

/**
 * Repair turn that keeps the tool-call protocol legal: echo the assistant
 * message and answer every tool call; without a tool call, a user message.
 */
function repairMessages(choice: Choice, issue: string): OpenAI.Chat.ChatCompletionMessageParam[] {
  const msg = choice?.message;
  const calls = msg?.tool_calls;
  if (!calls?.length) {
    return [{ role: "user", content: issue }];
  }
  return [
    { role: "assistant", content: msg?.content ?? null, tool_calls: calls },
    ...calls.map((c, i): OpenAI.Chat.ChatCompletionMessageParam => ({
      role: "tool",
      tool_call_id: c.id,
      content: i === 0 ? issue : "Ignored — call emit_course exactly once.",
    })),
  ];
}
