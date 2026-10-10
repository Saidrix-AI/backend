import { streamChatAgent } from "../src/agents/chat-agent/stream.js";
import { env } from "../src/config/env.js";

/**
 * Live check on the LangChain chat streaming loop, against a real provider.
 *
 * `forceSearch` makes turn 1 a forced web_search, so the run covers the whole
 * path and not just the happy first token: streamed content deltas, streamed
 * tool-call deltas reassembled from tool_call_chunks, a tool executed, its
 * result fed back as a ToolMessage (the one that needs `name` — see
 * agents/shared/forcedToolCall.ts), and a second round that answers from it.
 *
 *   npx tsx scripts/_probe-chat-stream.ts
 */

console.log(`[probe] provider=${env.LLM_PROVIDER} model=${env.LLM_MODEL}`);
if (!env.TAVILY_API_KEY) {
  console.error("[probe] needs TAVILY_API_KEY in backend/.env to force a search turn.");
  process.exit(1);
}

const seen = { thinking: 0, content: 0, toolCalls: [] as string[], toolResults: [] as string[] };
let answer = "";

try {
  for await (const ev of streamChatAgent([], "What is the latest stable Node.js LTS version?", {
    forceSearch: true,
  })) {
    switch (ev.type) {
      case "thinking":
        seen.thinking++;
        break;
      case "content":
        seen.content++;
        answer += ev.delta;
        break;
      case "tool_call":
        seen.toolCalls.push(ev.name);
        console.log(`[probe] tool_call  → ${ev.name} ${ev.query ? `(${ev.query})` : ""}`);
        break;
      case "tool_result":
        seen.toolResults.push(`${ev.name}:${ev.ok ? "ok" : "FAILED"}`);
        console.log(`[probe] tool_result← ${ev.name} ok=${ev.ok}`);
        break;
      default:
        break;
    }
  }

  console.log(`\n[probe] content deltas: ${seen.content}, thinking deltas: ${seen.thinking}`);
  console.log(`[probe] tools called: ${seen.toolCalls.join(", ") || "(none)"}`);
  console.log(`[probe] tool results: ${seen.toolResults.join(", ") || "(none)"}`);
  console.log(`[probe] answer: ${answer.slice(0, 300)}${answer.length > 300 ? "…" : ""}`);

  const ok = seen.toolCalls.length > 0 && seen.toolResults.length > 0 && answer.trim().length > 0;
  console.log(
    ok
      ? "\n[probe] PASS — tool call, tool result and a final answer all came through."
      : "\n[probe] FAIL — the loop did not complete a tool round trip with an answer.",
  );
  if (!ok) process.exitCode = 1;
} catch (err) {
  console.error("\n[probe] FAIL —", err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
