process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-at-least-16-chars";
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/placeholder-overridden-in-tests";
process.env.LLM_PROVIDER = "google";
// The .env sets LLM_REASONING_EFFORT=none for the gateway models; tests assert
// the per-model default, so the override must not leak in.
process.env.LLM_REASONING_EFFORT = "";
process.env.GOOGLE_API_KEY = "test-key";
// Force the RAG layer OFF in tests regardless of a populated .env, so unit tests
// stay deterministic and never make real Pinecone/embedding network calls.
// (dotenv does not override already-set process.env keys, so these win.)
process.env.PINECONE_API_KEY = "";
process.env.EMBEDDING_MODEL = "";
process.env.EMBEDDING_DIMENSIONS = "";
// Same for the freshness layer: `src/config/env.ts` imports dotenv, so a real
// TAVILY_API_KEY from .env would otherwise make every course/lecture generation
// test hit Tavily for real — slow, billed and different on every run. Only the
// flag is cleared, not the key, so a test that wants to exercise web search can
// turn it back on for itself.
process.env.AGENT_FRESHNESS_ENABLED = "false";
// And the lecture's closing Resources section, for exactly the same reason: it
// gates on TAVILY_API_KEY, which dotenv supplies, so every makeLecture test
// would run two real searches plus a real LLM call.
process.env.LECTURE_RESOURCES_ENABLED = "false";
// Diagram rendering OFF by default in tests, for the same reason: a unit test
// should not launch Chromium. Measurement falls back to the font-metrics path,
// which is deterministic, needs no browser and runs in microseconds — and the
// fallback is worth exercising, since it is what production uses when Chromium
// is unavailable. svg-browser.test.ts turns rendering back on for itself, and
// skips when no browser is installed.
process.env.LECTURE_SVG_RENDER_ENABLED = "false";
process.env.LECTURE_SVG_VISION_ENABLED = "false";
// Billing OFF by default, for the same "ignore a populated .env" reason. With
// real LEMONSQUEEZY_* keys present, `isBillingEnabled()` is true and the paywall
// answers 402 to every feature route — so a developer with billing configured
// locally saw most of the suite fail while CI passed. paywall.test.ts and
// billing-webhook.test.ts set these themselves, before importing app.js.
process.env.LEMONSQUEEZY_API_KEY = "";
process.env.LEMONSQUEEZY_STORE_ID = "";
process.env.LEMONSQUEEZY_WEBHOOK_SECRET = "";

// The one .env key tests are allowed to read. Chromium may be installed outside
// playwright's default location (it is a few hundred MB, so a developer may
// well have put it on another drive), and svg-browser.test.ts cannot find it
// without this. Deliberately not `dotenv/config`: the rest of .env holds real
// API keys, and the settings above exist precisely to keep them out of tests.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  try {
    const { readFileSync } = await import("node:fs");
    const path = readFileSync(new URL("../.env", import.meta.url), "utf8").match(
      /^PLAYWRIGHT_BROWSERS_PATH\s*=\s*(.+)$/m,
    )?.[1];
    if (path) process.env.PLAYWRIGHT_BROWSERS_PATH = path.trim().replace(/^["']|["']$/g, "");
  } catch {
    // No .env, or unreadable: playwright falls back to its default location.
  }
}
