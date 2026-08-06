import OpenAI from "openai";
import { env } from "../src/config/env.js";

/**
 * Provider smoke test: does the configured endpoint actually serve the three
 * things the agent layer depends on (chat, forced tool calls, vision)?
 *
 * The key is read from the environment — never hardcoded. A literal key here
 * once made it into the working tree and had to be rotated; keep it this way.
 */
const apiKey = env.TOKENROUTER_API_KEY ?? env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("Set TOKENROUTER_API_KEY (or OPENROUTER_API_KEY) in backend/.env first.");
  process.exit(1);
}

const client = new OpenAI({
  apiKey,
  baseURL: process.env.PROBE_BASE_URL ?? "https://api.tokenrouter.com/v1",
});
const model = process.env.PROBE_MODEL ?? env.LLM_MODEL ?? "z-ai/glm-5.2-free";

// 1. Basic chat
try {
  const r = await client.chat.completions.create({
    model, max_tokens: 50,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  });
  console.log("1. CHAT      : OK —", JSON.stringify(r.choices[0]?.message?.content?.slice(0, 40)));
} catch (e) { console.log("1. CHAT      : FAIL —", e instanceof Error ? e.message.slice(0, 120) : e); }

// 2. Forced tool call — the whole agent system depends on this
try {
  const r = await client.chat.completions.create({
    model, max_tokens: 120,
    messages: [{ role: "user", content: "Emit a plan with title 'Test' and two steps." }],
    tools: [{ type: "function", function: { name: "emit_plan", description: "Emit a plan",
      parameters: { type: "object", required: ["title", "steps"], properties: {
        title: { type: "string" }, steps: { type: "array", items: { type: "string" } } } } } }],
    tool_choice: { type: "function", function: { name: "emit_plan" } },
  });
  const call = r.choices[0]?.message?.tool_calls?.[0];
  console.log("2. TOOL CALL : ", call ? "OK — " + JSON.stringify(call.function?.arguments?.slice(0, 80)) : "FAIL — no tool_call returned");
} catch (e) { console.log("2. TOOL CALL : FAIL —", e instanceof Error ? e.message.slice(0, 150) : e); }

// 3. Vision — a tiny red PNG
const redDot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
try {
  const r = await client.chat.completions.create({
    model, max_tokens: 30,
    messages: [{ role: "user", content: [
      { type: "text", text: "What color is this 1x1 image? One word." },
      { type: "image_url", image_url: { url: `data:image/png;base64,${redDot}` } },
    ] }],
  });
  console.log("3. VISION    : OK —", JSON.stringify(r.choices[0]?.message?.content?.slice(0, 40)));
} catch (e) { console.log("3. VISION    : FAIL —", e instanceof Error ? e.message.slice(0, 120) : e); }
