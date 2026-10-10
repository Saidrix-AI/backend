import type { Request, Response } from "express";
import { isCodeRunnerEnabled } from "../config/env.js";
import * as codeRunner from "../services/codeRunner.service.js";

/**
 * What this deployment can run, and where.
 *
 * `browser` is always available — Pyodide and JS need no server at all — while
 * `remote` is empty when no Judge0 is configured. The classroom reads this to
 * decide whether a demo in a given language is possible before offering one.
 */
export async function getLanguages(_req: Request, res: Response): Promise<void> {
  res.json({
    success: true,
    data: {
      browser: ["python", "javascript"],
      remote: isCodeRunnerEnabled() ? codeRunner.SUPPORTED_LANGUAGES : [],
    },
  });
}

/**
 * Runs one program remotely and returns the same shape the browser runtime
 * produces, so the classroom can treat the two lanes as one.
 *
 * A program that crashes or fails to compile is a 200 with `ok: false` — that
 * is a result the tutor teaches from, not an API error. Only an unusable runner
 * produces a non-2xx.
 */
export async function run(req: Request, res: Response): Promise<void> {
  const { language, source, stdin } = req.body as {
    language: codeRunner.RunnerLanguage;
    source: string;
    stdin?: string;
  };
  const result = await codeRunner.runCode(language, source, stdin ?? "");
  res.json({ success: true, data: result });
}
