import { env, isCodeRunnerEnabled } from "../config/env.js";
import { ApiError } from "../utils/apiError.js";
import { logger } from "../utils/logger.js";

/**
 * The remote half of the classroom's code runner.
 *
 * Python and JavaScript run in the student's own browser — instantly, free, and
 * with no way to reach anything. This covers the rest of the curriculum, which
 * spans some thirty compiled and hosted languages a browser cannot run.
 *
 * Judge0, and proxied rather than called from the page: the key would otherwise
 * ship in the bundle, and the per-user limit has to sit somewhere the student
 * cannot edit. It also means switching to a self-hosted instance later is one
 * env var, not a frontend change.
 */

/** Judge0 status ids we care about. Everything else is some flavour of error. */
const STATUS_ACCEPTED = 3;
const STATUS_TIME_LIMIT = 5;
const STATUS_COMPILE_ERROR = 6;

/** Bigger than any teaching demo, small enough that nobody can post a payload. */
export const MAX_SOURCE_CHARS = 20000;

/**
 * Languages the remote runner offers, and how to recognise them in whatever
 * Judge0 instance is configured.
 *
 * Two layers on purpose. The **id** is the well-known Judge0 CE number and is
 * what gets used when the instance cannot be asked. The **match** is a pattern
 * against the live `/languages` list, which is what actually gets used — those
 * ids drift between Judge0 versions, and a drifted id does not error, it
 * silently compiles the student's Go as something else. Resolving by name once
 * per process removes that whole class of confusion.
 */
const LANGUAGES = {
  // Not /^C\b/: that also matches "C++ (GCC …)", listed after C, so C compiled as C++.
  c: { id: 50, match: /^C\s*\(GCC/i },
  cpp: { id: 54, match: /^C\+\+.*GCC/i },
  csharp: { id: 51, match: /^C#/i },
  java: { id: 62, match: /^Java\s*\(/i },
  go: { id: 60, match: /^Go\b/i },
  rust: { id: 73, match: /^Rust\b/i },
  ruby: { id: 72, match: /^Ruby\b/i },
  php: { id: 68, match: /^PHP\b/i },
  kotlin: { id: 78, match: /^Kotlin\b/i },
  swift: { id: 83, match: /^Swift\b/i },
  scala: { id: 81, match: /^Scala\b/i },
  haskell: { id: 61, match: /^Haskell\b/i },
  elixir: { id: 57, match: /^Elixir\b/i },
  erlang: { id: 58, match: /^Erlang\b/i },
  lua: { id: 64, match: /^Lua\b/i },
  r: { id: 80, match: /^R\s*\(/i },
  perl: { id: 85, match: /^Perl\b/i },
  bash: { id: 46, match: /^Bash\b/i },
  fortran: { id: 59, match: /^Fortran\b/i },
  cobol: { id: 77, match: /^COBOL\b/i },
  pascal: { id: 67, match: /^Pascal\b/i },
  ocaml: { id: 65, match: /^OCaml\b/i },
  "objective-c": { id: 79, match: /^Objective-C\b/i },
  "common-lisp": { id: 55, match: /^Common Lisp\b/i },
  dart: { id: 90, match: /^Dart\b/i },
  typescript: { id: 74, match: /^TypeScript\b/i },
  // Present so a lecture that asks for them still works if the browser lane is
  // unavailable — normally these never reach here.
  python: { id: 71, match: /^Python\s*\(3/i },
  javascript: { id: 63, match: /^JavaScript\b/i },
} as const;

export type RunnerLanguage = keyof typeof LANGUAGES;

export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGES) as RunnerLanguage[];

export function isRunnerLanguage(value: string): value is RunnerLanguage {
  return Object.prototype.hasOwnProperty.call(LANGUAGES, value);
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Resolved once per process; null until the first successful lookup. */
let resolvedIds: Partial<Record<RunnerLanguage, number>> | null = null;
let resolving: Promise<void> | null = null;

function headers(): Record<string, string> {
  const out: Record<string, string> = { "Content-Type": "application/json" };
  if (env.JUDGE0_API_KEY) {
    // RapidAPI's scheme. A self-hosted instance ignores both and usually wants
    // no auth at all, which is why they are separate optional vars.
    out["X-RapidAPI-Key"] = env.JUDGE0_API_KEY;
    out["X-Auth-Token"] = env.JUDGE0_API_KEY;
  }
  if (env.JUDGE0_API_HOST) out["X-RapidAPI-Host"] = env.JUDGE0_API_HOST;
  return out;
}

function base(): string {
  return (env.JUDGE0_URL ?? "").replace(/\/$/, "");
}

/**
 * Asks the instance what ids it actually uses, once.
 *
 * Failure is not fatal — the static ids are the fallback, and on a stock
 * Judge0 CE they are correct. It is logged loudly though, because running on
 * unverified ids is exactly the state where a mismatch would go unnoticed.
 */
async function resolveLanguageIds(): Promise<void> {
  try {
    const res = await fetch(`${base()}/languages`, {
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = (await res.json()) as Array<{ id?: number; name?: string }>;

    const resolved: Partial<Record<RunnerLanguage, number>> = {};
    for (const [slug, spec] of Object.entries(LANGUAGES) as [
      RunnerLanguage,
      { id: number; match: RegExp },
    ][]) {
      // Last match wins: Judge0 lists older versions alongside newer ones, and
      // the newest is what a lesson written this year should compile against.
      const hit = list.filter((l) => l.name && spec.match.test(l.name)).pop();
      if (hit?.id) resolved[slug] = hit.id;
    }
    resolvedIds = resolved;

    const missing = SUPPORTED_LANGUAGES.filter((l) => resolved[l] === undefined);
    if (missing.length) {
      logger.warn(
        { missing },
        "[code-runner] this Judge0 instance offers no build for some languages — they will fall back to static ids",
      );
    }
  } catch (err) {
    logger.warn({ err }, "[code-runner] could not read /languages; using built-in Judge0 CE ids");
    resolvedIds = {};
  }
}

async function languageId(language: RunnerLanguage): Promise<number> {
  if (resolvedIds === null) {
    resolving ??= resolveLanguageIds().finally(() => {
      resolving = null;
    });
    await resolving;
  }
  return resolvedIds?.[language] ?? LANGUAGES[language].id;
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const unb64 = (text: string | null | undefined) =>
  text ? Buffer.from(text, "base64").toString("utf8") : "";

/**
 * Compiles and runs one program, returning the same shape the browser runtime
 * returns — that symmetry is what lets the classroom treat the two lanes as one
 * thing and pick between them purely on language.
 *
 * Never throws for a *program* failure: a compile error or a crash is a result
 * the tutor talks about. It throws only when the runner itself is unusable,
 * which the caller turns into "you cannot run code this session".
 */
export async function runCode(
  language: RunnerLanguage,
  source: string,
  stdin = "",
): Promise<RunResult> {
  if (!isCodeRunnerEnabled()) {
    throw new ApiError(503, "The code runner is not configured");
  }
  if (source.length > MAX_SOURCE_CHARS) {
    throw new ApiError(400, `Source exceeds ${MAX_SOURCE_CHARS} characters`);
  }

  const startedAt = Date.now();
  const submission = {
    source_code: b64(source),
    language_id: await languageId(language),
    stdin: b64(stdin),
    cpu_time_limit: env.JUDGE0_CPU_LIMIT_S,
    wall_time_limit: env.JUDGE0_WALL_LIMIT_S,
    memory_limit: env.JUDGE0_MEMORY_LIMIT_KB,
  };

  // base64 both ways. Not optional: source and output are arbitrary bytes, and
  // plain mode has mangled non-ASCII and control characters often enough that
  // Judge0's own docs steer you here.
  const url = `${base()}/submissions?base64_encoded=true&wait=true`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(submission),
    signal: AbortSignal.timeout(env.JUDGE0_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn({ status: res.status, body: text.slice(0, 200) }, "[code-runner] submission failed");
    throw new ApiError(502, "The code runner is unavailable right now");
  }

  let body = (await res.json()) as Judge0Result;

  // `wait=true` is disabled on some instances, which answer with a bare token
  // instead of a result. Polling that token covers both configurations, so a
  // deployment cannot half-work depending on a setting nobody looked at.
  if (!body.status && body.token) body = await pollUntilDone(body.token, startedAt);

  return toRunResult(body, Date.now() - startedAt);
}

interface Judge0Result {
  token?: string;
  stdout?: string | null;
  stderr?: string | null;
  compile_output?: string | null;
  message?: string | null;
  time?: string | null;
  status?: { id: number; description?: string };
}

async function pollUntilDone(token: string, startedAt: number): Promise<Judge0Result> {
  const deadline = startedAt + env.JUDGE0_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const res = await fetch(`${base()}/submissions/${token}?base64_encoded=true`, {
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) continue;
    const body = (await res.json()) as Judge0Result;
    // 1 = In Queue, 2 = Processing. Anything above is terminal.
    if (body.status && body.status.id > 2) return body;
  }
  throw new ApiError(504, "The code runner took too long");
}

function toRunResult(body: Judge0Result, durationMs: number): RunResult {
  const statusId = body.status?.id ?? 0;
  const stdout = unb64(body.stdout);
  const compile = unb64(body.compile_output);
  const runtime = unb64(body.stderr);
  const message = unb64(body.message);

  // Compile output first: for a compiled language it IS the error the student
  // needs, and Judge0 reports it in its own field rather than on stderr.
  const stderr =
    [compile, runtime, message].filter(Boolean).join("\n").trim() ||
    (statusId !== STATUS_ACCEPTED ? (body.status?.description ?? "") : "");

  return {
    ok: statusId === STATUS_ACCEPTED,
    stdout,
    stderr:
      statusId === STATUS_COMPILE_ERROR && !stderr ? "The program did not compile." : stderr,
    timedOut: statusId === STATUS_TIME_LIMIT,
    durationMs: Math.round(Number(body.time ?? 0) * 1000) || durationMs,
  };
}
