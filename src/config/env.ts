import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5000),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),

  // Number of trusted proxy hops in front of the app (Express `trust proxy`).
  // 0 = trust none (safe default for local/no-proxy). Set to the real hop count
  // in production (e.g. 1 behind a single Nginx/Cloudflare) so req.ip — and thus
  // per-IP rate limiting — can't be spoofed via X-Forwarded-For.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  // --- Auth: access token (JWT) ---
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),

  // --- Auth: refresh token (opaque, stored hashed) ---
  REFRESH_TOKEN_EXPIRES_IN_DAYS: z.coerce.number().int().positive().default(30),

  // --- Cookies / CORS ---
  // Comma-separated allowlist of browser origins permitted to send credentials.
  CORS_ORIGIN: z.string().default("http://localhost:5173,http://localhost:5174"),
  COOKIE_DOMAIN: z.string().optional(),

  // --- Email (optional; console fallback in dev when unset) ---
  // Empty strings in .env are treated as "unset" for these optional fields.
  SMTP_HOST: z.preprocess((v) => v || undefined, z.string().optional()),
  SMTP_PORT: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  SMTP_USER: z.preprocess((v) => v || undefined, z.string().optional()),
  SMTP_PASS: z.preprocess((v) => v || undefined, z.string().optional()),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  MAIL_FROM: z.string().default("Saidrix AI Tutor <no-reply@saidrix.com>"),
  // Where the contact forms deliver. Fixed here on purpose and NEVER taken from
  // a request: a recipient supplied by the caller would turn the public contact
  // endpoint into an open relay sending from our own domain, which would cost
  // the sending reputation that signup and password-reset mail depends on.
  CONTACT_INBOX: z.string().email().default("sifuddin.soad@saidrix.com"),

  // --- Billing (LemonSqueezy) ---
  // LemonSqueezy is the merchant of record: it owns cards, VAT and invoices, so
  // no payment instrument ever reaches this server. Without the three required
  // keys below `isBillingEnabled()` is false and the paywall no-ops entirely —
  // which is what lets local development and the test suite run unpaid.
  LEMONSQUEEZY_API_KEY: z.preprocess((v) => v || undefined, z.string().optional()),
  LEMONSQUEEZY_STORE_ID: z.preprocess((v) => v || undefined, z.string().optional()),
  // The secret entered when creating the webhook in the LemonSqueezy dashboard;
  // every incoming request is HMAC-verified against it.
  LEMONSQUEEZY_WEBHOOK_SECRET: z.preprocess((v) => v || undefined, z.string().optional()),
  // Refuses to grant a plan from a test-mode purchase while true is expected.
  // Production must run with this false, or a $0 test checkout would unlock a
  // real account — see services/subscription.service.ts.
  LEMONSQUEEZY_TEST_MODE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // The six variant ids (3 products x monthly/yearly). Mapped in config/entitlements.ts.
  LS_VARIANT_BASIC_MONTHLY: z.preprocess((v) => v || undefined, z.string().optional()),
  LS_VARIANT_BASIC_YEARLY: z.preprocess((v) => v || undefined, z.string().optional()),
  LS_VARIANT_PRO_MONTHLY: z.preprocess((v) => v || undefined, z.string().optional()),
  LS_VARIANT_PRO_YEARLY: z.preprocess((v) => v || undefined, z.string().optional()),
  LS_VARIANT_PREMIUM_MONTHLY: z.preprocess((v) => v || undefined, z.string().optional()),
  LS_VARIANT_PREMIUM_YEARLY: z.preprocess((v) => v || undefined, z.string().optional()),
  // How many days the free trial runs, or 0 for no trial. MUST match what the
  // Basic variants are configured with in the LemonSqueezy dashboard — the API
  // does not tell us at request time, so this is our declaration of it.
  //
  // It drives two things: what the public pages advertise, and whether a
  // checkout asks LemonSqueezy to honour the trial or skip it (see
  // controller/billing.controller.ts#checkout). Above zero with no trial
  // actually configured would advertise a free day and then charge for it.
  TRIAL_DAYS: z.coerce.number().int().min(0).max(90).default(0),
  // Where a finished checkout sends the buyer back to. Browser origin, not the API.
  APP_URL: z.string().default("http://localhost:5173"),

  // --- LiveKit (voice sessions) ---
  // These keep their `livekit-server --dev` defaults so local work needs no
  // setup, but production refuses to boot on them — see assertProductionSafe
  // below. Silently running the public dev pair in production was a real hole:
  // anyone who can reach the LiveKit server can create rooms with it.
  LIVEKIT_URL: z.string().default("ws://localhost:7880"),
  LIVEKIT_API_KEY: z.string().default("devkey"),
  LIVEKIT_API_SECRET: z.string().default("secret"),

  // How many students may be in a live class at once.
  //
  // Set by the SPEECH plan, not by LiveKit: Cartesia bills simultaneous
  // requests, and past the limit it rejects the synthesis — which reaches the
  // student as a tutor that joins and then says nothing. Refusing with a 429
  // the classroom can explain is better than that in every way.
  //
  // Defaults to the Scale plan's 15. 0 disables the check.
  VOICE_MAX_CONCURRENT_SESSIONS: z.coerce.number().int().min(0).default(15),

  // The secret the voice agent signs its own service tokens with.
  //
  // The agent mints a token on behalf of whichever student is in the room, so
  // whoever holds this secret can act as any user. It must therefore NOT be the
  // login secret: sharing JWT_ACCESS_SECRET means a compromised voice host is
  // account takeover for the whole app. Optional here so existing local setups
  // keep working (it falls back to JWT_ACCESS_SECRET in development), but
  // production requires it and requires it to be different.
  VOICE_SERVICE_SECRET: z.preprocess((v) => v || undefined, z.string().min(32).optional()),

  // --- LLM providers ---
  LLM_PROVIDER: z
    .enum(["anthropic", "openai", "google", "vercel"])
    .default("vercel"),
  LLM_MODEL: z.string().optional(),
  // Escape hatch for the reasoning-effort rule in agents/llm.ts. Leave unset:
  // the default is derived from the model name. Set it when a new model needs a
  // different value than the derivation picks (see reasoningParams there).
  LLM_REASONING_EFFORT: z.preprocess(
    (v) => v || undefined,
    z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
  ),
  // Per-LLM-call timeout for forced tool calls. Reasoning models (e.g.
  // z-ai/glm-5.2) think before answering and are far slower than instruct
  // models — 60s was enough for gpt-4o-mini but times out the lecture planner
  // and project planner on a reasoning model. Raise this if calls still time out.
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  // Last resort for the generation agents when LLM_MODEL keeps failing with
  // transient provider errors — see runForcedToolCall. Unset (the default)
  // means no fallback and the failure surfaces as it always did. Point it at a
  // model on a DIFFERENT reliability footing than LLM_MODEL, or it buys
  // nothing: the case this exists for is a free tier shedding load while the
  // paid model on the same key answers fine.
  LLM_FALLBACK_MODEL: z.string().optional(),
  // Overrides LLM_MODEL for the Course-maker agent's outline call only.
  COURSE_MAKER_MODEL: z.string().optional(),
  // Course-maker second phase: one call per chapter writes that chapter's
  // modules and lessons; one call plans the linked projects. Both fall back to
  // COURSE_MAKER_MODEL, then LLM_MODEL.
  COURSE_EXPAND_MODEL: z.string().optional(),
  PROJECT_PLANNER_MODEL: z.string().optional(),
  // Knowledge-check rounds and the final profile (agents/knowledge-profiler).
  ASSESSMENT_MODEL: z.string().optional(),
  // Rewrites the student's rolling memory from their chats (agents/memory-distiller).
  // One short background call per ~4 exchanges; falls back to COURSE_MAKER_MODEL,
  // then LLM_MODEL.
  MEMORY_DISTILLER_MODEL: z.string().optional(),
  // Per-call output cap for the course pipeline. 16384 = gpt-4o family max.
  // Total course size is unbounded because the curriculum is split across one
  // call per chapter — this only caps how big a single chapter can be.
  COURSE_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(16384),
  // Lecture-maker agent model overrides (fall back per role; see agents/lecture-maker/call.ts).
  // The analyst is one short call that every later call reads, so it is the
  // cheapest place to buy a stronger model if lecture quality needs lifting.
  // Routes each lesson to the concept lecture or the setup guide. Runs on every
  // lesson and is a two-way sort, so leave it on the cheap default.
  LECTURE_CLASSIFIER_MODEL: z.string().optional(),
  LECTURE_ANALYST_MODEL: z.string().optional(),
  LECTURE_PLANNER_MODEL: z.string().optional(),
  LECTURE_WORKER_MODEL: z.string().optional(),
  LECTURE_SVG_MODEL: z.string().optional(),
  // Per-call output cap. 16384 = gpt-4o family max; total lecture size is unbounded
  // because output is split across per-topic/per-block calls.
  LECTURE_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(16384),
  // The svg worker gets its own, much tighter budget. A finished diagram costs
  // ~800-1500 completion tokens; the rest of the allowance only ever funds
  // runaway generation, which on a cheap model burned the full 16384 tokens
  // over 264s before failing. Cutting it here makes a runaway fail fast and
  // cheap, and leaves the "draw something simpler" repair round a real chance.
  LECTURE_SVG_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(4096),
  // One drawing on a cheap model can legitimately take a couple of minutes —
  // well past the 60s default the other roles use.
  LECTURE_SVG_TIMEOUT_MS: z.coerce.number().int().positive().default(150_000),
  // --- Diagram inspection (see agents/lecture-maker/browser.ts) -------------
  // Each drawing is rendered in headless Chromium so its geometry is measured
  // rather than guessed from the markup. Set false to run without Chromium
  // installed: measurement degrades to the font-metrics fallback and the vision
  // pass is skipped. Lectures still generate either way.
  LECTURE_SVG_RENDER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Rendering + measuring is ~80ms against a ~15s worker call, so this ceiling
  // only ever catches a wedged browser, never normal work.
  LECTURE_SVG_RENDER_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // Pages open at once. The svg workers run in parallel, and an uncapped pool
  // would open one Chromium tab per diagram in the lecture simultaneously.
  LECTURE_SVG_RENDER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // Shut the browser down after this long with no diagrams to inspect, so an
  // idle server holds no Chromium process.
  LECTURE_SVG_BROWSER_IDLE_MS: z.coerce.number().int().positive().default(120_000),
  // Shows the rendered drawing to a vision model, which judges what the code
  // checks cannot: whether it reads clearly and sits sensibly on the canvas.
  LECTURE_SVG_VISION_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Defaults to the resolved svg model, which is already vision-capable.
  LECTURE_SVG_VISION_MODEL: z.string().optional(),
  // Closing "Resources" section: two web searches for real links, then a cheap
  // model picks from them by index. It only ranks a supplied list, so the
  // cheapest model is fine; defaults to LLM_MODEL.
  LECTURE_RESOURCES_MODEL: z.string().optional(),
  // Set false to end lectures at the quiz, as they did before this existed.
  LECTURE_RESOURCES_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Attempts allowed per diagram: the first draw plus repair rounds. The other
  // agents get 2 (one repair); a diagram earns a third because it is now given
  // measured coordinates to correct rather than prose.
  LECTURE_SVG_REPAIR_ROUNDS: z.coerce.number().int().min(1).max(5).default(3),
  // Overrides LLM_MODEL for the project reviewer and the project-requirements
  // author (the requirements are the contract the reviewer grades against, so
  // both run on the same model).
  PROJECT_REVIEW_MODEL: z.string().optional(),
  // Per-call output cap for review calls; a review is split across one call per
  // file plus one requirement-checker call, so total size is unbounded.
  PROJECT_REVIEW_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8192),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  // Vercel AI Gateway (LLM_PROVIDER=vercel). Same name Vercel's own SDKs read.
  AI_GATEWAY_API_KEY: z.string().optional(),
  TAVILY_API_KEY: z.preprocess((v) => v || undefined, z.string().optional()),

  // --- Freshness (live web search folded into generation) ---
  // The course-maker and lecture-maker run one web search per generation unit
  // and inject the results into their prompts, so a course/lecture is written
  // against what is current rather than against the model's training cutoff.
  // Off automatically without TAVILY_API_KEY; set false to disable it while
  // keeping the chat agent's web_search tool working.
  AGENT_FRESHNESS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Results per freshness search. Small on purpose — the block is injected into
  // every generation prompt, and snippets crowd out the curriculum grounding.
  AGENT_FRESHNESS_MAX_RESULTS: z.coerce.number().int().min(1).max(10).default(5),
  // How long an identical freshness query is reused, in minutes. A course
  // generation fires one search for the outline plus one per chapter on closely
  // related queries; "latest" does not change within a single generation.
  AGENT_FRESHNESS_CACHE_MINUTES: z.coerce.number().int().min(0).default(60),

  // --- Remote code runner (Judge0) ---
  //
  // The classroom runs Python and JavaScript in the student's own browser, for
  // free and with no round trip. This covers everything else — the ~30 other
  // languages in the curriculum that a browser cannot host: C, C++, Java, Go,
  // Rust, Ruby, PHP, Kotlin and the rest.
  //
  // Deliberately proxied through this backend rather than called from the
  // browser: the key would otherwise be in the page source, and the per-user
  // rate limit has to live somewhere the student cannot edit.
  //
  // Unset = the remote lane is simply off, and the tutor is told it may only
  // demonstrate Python and JavaScript. That is a real, supported configuration:
  // the browser lane needs nothing.
  JUDGE0_URL: z.preprocess((v) => v || undefined, z.string().url().optional()),
  JUDGE0_API_KEY: z.preprocess((v) => v || undefined, z.string().optional()),
  // RapidAPI sends the key as x-rapidapi-key plus an x-rapidapi-host header. A
  // self-hosted Judge0 wants neither — leave both blank there.
  JUDGE0_API_HOST: z.preprocess((v) => v || undefined, z.string().optional()),
  // Seconds of CPU a submission may burn. Teaching demos finish in well under
  // one; this is the ceiling that stops an accidental infinite loop from
  // occupying a worker.
  JUDGE0_CPU_LIMIT_S: z.coerce.number().min(1).max(15).default(5),
  // Wall-clock seconds, which also covers compilation — a cold C++ or Java
  // compile is most of the time a student waits.
  JUDGE0_WALL_LIMIT_S: z.coerce.number().min(2).max(30).default(15),
  JUDGE0_MEMORY_LIMIT_KB: z.coerce.number().int().min(16000).max(512000).default(128000),
  // How long the backend itself waits before giving up on the whole exchange.
  JUDGE0_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // --- RAG knowledge base (Course-Content curriculum) ---
  // Pinecone vector DB. Without PINECONE_API_KEY the whole RAG layer is off:
  // the search_course_content tool is not registered and agent grounding is
  // skipped, so the app behaves exactly as before.
  PINECONE_API_KEY: z.preprocess((v) => v || undefined, z.string().optional()),
  PINECONE_INDEX: z.string().default("saidrix-knowledge"),
  PINECONE_NAMESPACE: z.string().default("course-content"),
  // Serverless index spec — only read when the index is first created.
  PINECONE_CLOUD: z.string().default("aws"),
  PINECONE_REGION: z.string().default("us-east-1"),

  // Embeddings via any OpenAI-compatible endpoint. Defaults to OpenRouter's
  // base/key, but note OpenRouter may not serve an /embeddings endpoint for a
  // given model — if so, point EMBEDDING_BASE_URL at an OpenAI-compatible
  // embeddings provider (OpenAI, Voyage, Jina, Together, …). One env change,
  // no code change. EMBEDDING_MODEL + EMBEDDING_DIMENSIONS are required for RAG.
  EMBEDDING_BASE_URL: z.string().default("https://ai-gateway.vercel.sh/v1"),
  EMBEDDING_API_KEY: z.preprocess((v) => v || undefined, z.string().optional()),
  EMBEDDING_MODEL: z.preprocess((v) => v || undefined, z.string().optional()),
  EMBEDDING_DIMENSIONS: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  RAG_TOP_K: z.coerce.number().int().positive().default(6),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

/**
 * Refuses to start a production server that is still wearing its development
 * clothes.
 *
 * Every variable below has a convenient default so local work needs no setup —
 * which is exactly why each one was, at some point, still at that default on a
 * server that was about to take real traffic. A default that is safe in
 * development and unsafe in production has to be caught by something; a comment
 * in .env.example is not something.
 *
 * Deliberately a hard exit rather than a warning. A warning scrolls past.
 */
export function productionConfigProblems(e: Env = env): string[] {
  if (e.NODE_ENV !== "production") return [];
  const problems: string[] = [];

  if (e.LIVEKIT_API_KEY === "devkey" || e.LIVEKIT_API_SECRET === "secret") {
    problems.push(
      "LIVEKIT_API_KEY/LIVEKIT_API_SECRET are still the public `livekit-server --dev` pair. " +
        "Anyone who can reach your LiveKit server could mint rooms with these. Set real keys.",
    );
  }
  if (e.LIVEKIT_URL.startsWith("ws://") && !e.LIVEKIT_URL.includes("localhost")) {
    problems.push("LIVEKIT_URL is plaintext ws:// on a non-local host. Use wss://.");
  }

  // The agent signs tokens for arbitrary users; sharing the login secret turns a
  // voice-host compromise into full account takeover.
  if (!e.VOICE_SERVICE_SECRET) {
    problems.push(
      "VOICE_SERVICE_SECRET is unset. The voice agent would fall back to JWT_ACCESS_SECRET, " +
        "which lets anyone holding it mint a login token for any account. Set a separate 32+ char secret.",
    );
  } else if (e.VOICE_SERVICE_SECRET === e.JWT_ACCESS_SECRET) {
    problems.push("VOICE_SERVICE_SECRET must not equal JWT_ACCESS_SECRET — that defeats the point of separating them.");
  }

  // A $0 test checkout must not unlock a real account.
  if (e.LEMONSQUEEZY_TEST_MODE && e.LEMONSQUEEZY_API_KEY && e.LEMONSQUEEZY_WEBHOOK_SECRET) {
    problems.push(
      "LEMONSQUEEZY_TEST_MODE=true with live billing keys present. Every tier would be free to " +
        "anyone who found a test checkout link. Set LEMONSQUEEZY_TEST_MODE=false.",
    );
  }

  const localOrigins = e.CORS_ORIGIN.split(",").filter((o) => /localhost|127\.0\.0\.1/.test(o));
  if (localOrigins.length > 0) {
    problems.push(`CORS_ORIGIN still allows local origins (${localOrigins.join(", ")}). Set your real frontend origin(s).`);
  }
  if (/localhost|127\.0\.0\.1/.test(e.APP_URL)) {
    problems.push("APP_URL is still localhost — checkout would return the buyer to a dead link.");
  }

  // Behind a proxy this must match the real hop count, or req.ip is the proxy's
  // and every per-IP rate limit collapses into one shared bucket.
  if (e.TRUST_PROXY === 0) {
    problems.push(
      "TRUST_PROXY=0 in production. If you run behind Nginx/Cloudflare/a platform router, set it to the " +
        "real hop count (usually 1) or rate limiting and secure cookies read the wrong client IP.",
    );
  }

  if (/change|example|secret|password|123456/i.test(e.JWT_ACCESS_SECRET)) {
    problems.push("JWT_ACCESS_SECRET looks like a placeholder. Generate one: openssl rand -base64 48");
  }

  return problems;
}

const configProblems = productionConfigProblems();
if (configProblems.length > 0) {
  // eslint-disable-next-line no-console
  console.error(
    `Refusing to start in production with an unsafe configuration:\n${configProblems
      .map((p) => `  - ${p}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

/**
 * The secret the voice agent's service tokens are signed with. Falls back to the
 * login secret in development only — production cannot reach this branch,
 * because the check above exits first.
 */
export const voiceServiceSecret = env.VOICE_SERVICE_SECRET ?? env.JWT_ACCESS_SECRET;

/**
 * Resolved RAG settings. `apiKey` is the embeddings key with the AI Gateway key
 * as fallback, matching how the rest of the app authenticates to the gateway.
 */
export const ragConfig = {
  pineconeApiKey: env.PINECONE_API_KEY,
  pineconeIndex: env.PINECONE_INDEX,
  pineconeNamespace: env.PINECONE_NAMESPACE,
  pineconeCloud: env.PINECONE_CLOUD,
  pineconeRegion: env.PINECONE_REGION,
  embeddingBaseUrl: env.EMBEDDING_BASE_URL,
  embeddingApiKey: env.EMBEDDING_API_KEY ?? env.AI_GATEWAY_API_KEY,
  embeddingModel: env.EMBEDDING_MODEL,
  embeddingDimensions: env.EMBEDDING_DIMENSIONS,
  topK: env.RAG_TOP_K,
} as const;

/**
 * Whether the remote code runner is configured.
 *
 * A URL is the whole requirement: a self-hosted Judge0 needs no key, and a
 * hosted one supplies it separately. False is a supported state, not a
 * misconfiguration — the classroom keeps its browser lane and the voice agent
 * is told it may only demonstrate Python and JavaScript.
 */
export function isCodeRunnerEnabled(): boolean {
  return Boolean(env.JUDGE0_URL);
}

/**
 * RAG is usable only when Pinecone auth, an embedding model + its dimensions,
 * and a key for the embeddings endpoint are all present. Everything downstream
 * checks this and no-ops gracefully when false.
 */
export function isRagEnabled(): boolean {
  return Boolean(
    ragConfig.pineconeApiKey &&
      ragConfig.embeddingModel &&
      ragConfig.embeddingDimensions &&
      ragConfig.embeddingApiKey,
  );
}

/**
 * Live web search is folded into course/lecture generation only when a Tavily
 * key exists AND the flag is on. Everything downstream checks this and no-ops
 * gracefully when false, exactly like `isRagEnabled`.
 */
export function isFreshnessEnabled(): boolean {
  return Boolean(env.AGENT_FRESHNESS_ENABLED && env.TAVILY_API_KEY);
}

/**
 * The lecture's closing Resources section needs Tavily as well as its own flag:
 * every link is copied from a search result, never written by a model, so
 * without a search there is nothing legitimate to show.
 */
export function isResourcesEnabled(): boolean {
  return Boolean(env.LECTURE_RESOURCES_ENABLED && env.TAVILY_API_KEY);
}

/**
 * Billing is live only with a store, an API key and a webhook secret. Every
 * call site checks this and degrades gracefully when false — the paywall opens,
 * checkout 503s — exactly like `isRagEnabled`. That is deliberate: a missing
 * key must not lock every existing user out of an app they already paid for.
 */
export function isBillingEnabled(): boolean {
  return Boolean(
    env.LEMONSQUEEZY_API_KEY && env.LEMONSQUEEZY_STORE_ID && env.LEMONSQUEEZY_WEBHOOK_SECRET,
  );
}

/** Browser origins allowed to send credentialed (cookie) requests. */
export const corsOrigins = env.CORS_ORIGIN.split(",")
  .map((o) => o.trim())
  .filter(Boolean);
