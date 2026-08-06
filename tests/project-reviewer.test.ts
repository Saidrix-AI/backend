import { describe, expect, it } from "vitest";
import type { IngestedProject } from "../src/agents/project-reviewer/github.js";
import { reviewProject } from "../src/agents/project-reviewer/index.js";
import {
  buildFileWorkerUserMessage,
  buildRequirementCheckerUserMessage,
  withLineNumbers,
  type ReviewContext,
} from "../src/agents/project-reviewer/prompt.js";
import { computeQualityScore, countBySeverity } from "../src/agents/project-reviewer/score.js";
import { fileReviewSchemaFor, requirementReportSchemaFor } from "../src/agents/project-reviewer/schema.js";
import { runFileWorker, runRequirementChecker } from "../src/agents/project-reviewer/workers.js";
import { fakeDeps, textResponse, toolCallResponse } from "./helpers/fakeLlm.js";

const CTX: ReviewContext = {
  title: "Number Guessing Game",
  desc: "A CLI guessing game.",
  goal: "Build a CLI game where the player guesses a number.",
  requirements: ["Must define a main() function", "Must handle non-numeric input"],
};

const FILE = { path: "main.py", language: "python", content: "import random\n\ndef main():\n    pass\n" };

const REPORT = {
  requirementResults: [
    { requirement: "Must define a main() function", met: true, evidence: "main.py:3" },
    { requirement: "Must handle non-numeric input", met: false, evidence: "no try/except around input()" },
  ],
  overallFeedback: "Good start. Add input validation next.",
};

function ingested(files = [FILE], extra: Partial<IngestedProject> = {}): IngestedProject {
  return {
    files,
    paths: [...files.map((f) => f.path), "README.md"],
    truncated: false,
    rootName: "guessing-game",
    ...extra,
  };
}

describe("withLineNumbers", () => {
  it("prefixes every line, 1-based", () => {
    expect(withLineNumbers("a\nb\nc")).toBe("1\ta\n2\tb\n3\tc");
  });
});

describe("prompts", () => {
  it("the file worker message carries the goal, requirements and numbered source", () => {
    const msg = buildFileWorkerUserMessage(CTX, FILE);
    expect(msg).toContain("Goal: Build a CLI game");
    expect(msg).toContain("1. Must define a main() function");
    expect(msg).toContain("3\tdef main():");
    expect(msg).toContain("main.py");
  });

  it("the requirement-checker message lists every path and warns when truncated", () => {
    const msg = buildRequirementCheckerUserMessage(CTX, [FILE], ["main.py", "README.md"], true);
    expect(msg).toContain("- README.md");
    expect(msg).toContain("--- main.py ---");
    expect(msg).toContain("some files below are omitted");
  });

  it("says nothing about omitted files when the whole project was reviewed", () => {
    expect(buildRequirementCheckerUserMessage(CTX, [FILE], ["main.py"], false)).not.toContain("omitted");
  });
});

describe("fileReviewSchemaFor", () => {
  const schema = fileReviewSchemaFor(4);

  it("accepts issues on real lines", () => {
    expect(schema.safeParse({ issues: [{ line: 3, severity: "error", text: "bad" }] }).success).toBe(true);
  });

  it("accepts a clean file", () => {
    expect(schema.safeParse({ issues: [] }).success).toBe(true);
  });

  it("rejects an issue anchored past the end of the file", () => {
    const r = schema.safeParse({ issues: [{ line: 99, severity: "error", text: "bad" }] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("past the end of the file");
  });

  it("rejects an unknown severity", () => {
    expect(schema.safeParse({ issues: [{ line: 1, severity: "nit", text: "x" }] }).success).toBe(false);
  });
});

describe("requirementReportSchemaFor", () => {
  it("demands one result per requirement", () => {
    const schema = requirementReportSchemaFor(CTX.requirements);
    expect(schema.safeParse(REPORT).success).toBe(true);
    const short = { ...REPORT, requirementResults: REPORT.requirementResults.slice(0, 1) };
    expect(schema.safeParse(short).success).toBe(false);
  });
});

describe("computeQualityScore", () => {
  it("is a perfect score with no issues and every requirement met", () => {
    expect(computeQualityScore({ errors: 0, warnings: 0, suggestions: 0 }, 4, 4)).toBe(100);
  });

  it("weights requirements above code cleanliness", () => {
    const halfReqs = computeQualityScore({ errors: 0, warnings: 0, suggestions: 0 }, 2, 4);
    const someIssues = computeQualityScore({ errors: 2, warnings: 2, suggestions: 2 }, 4, 4);
    expect(halfReqs).toBe(70); // 50*0.6 + 100*0.4
    expect(someIssues).toBeGreaterThan(halfReqs);
  });

  it("falls back to the code score when there are no requirements", () => {
    expect(computeQualityScore({ errors: 1, warnings: 1, suggestions: 0 }, 0, 0)).toBe(93);
  });

  it("never goes below zero", () => {
    expect(computeQualityScore({ errors: 50, warnings: 0, suggestions: 0 }, 0, 4)).toBe(0);
  });

  it("counts by severity", () => {
    expect(countBySeverity(["error", "warning", "error", "suggestion"])).toEqual({
      errors: 2,
      warnings: 1,
      suggestions: 1,
    });
  });
});

describe("runFileWorker", () => {
  it("returns issues sorted by line", async () => {
    const { deps } = fakeDeps(
      toolCallResponse("emit_file_review", {
        issues: [
          { line: 3, severity: "warning", text: "empty body" },
          { line: 1, severity: "suggestion", text: "unused import" },
        ],
      }),
    );
    const issues = await runFileWorker(CTX, FILE, deps);
    expect(issues!.map((i) => i.line)).toEqual([1, 3]);
  });

  it("returns null instead of throwing after two invalid attempts", async () => {
    const { deps } = fakeDeps(
      toolCallResponse("emit_file_review", { issues: [{ line: 999, severity: "error", text: "x" }] }),
      textResponse("sorry"),
    );
    await expect(runFileWorker(CTX, FILE, deps)).resolves.toBeNull();
  });
});

describe("runRequirementChecker", () => {
  it("keeps our requirement text even when the model paraphrases it", async () => {
    const paraphrased = {
      ...REPORT,
      requirementResults: [
        { requirement: "define main", met: true, evidence: "main.py:3" },
        { requirement: "handle bad input", met: false, evidence: "missing" },
      ],
    };
    const { deps } = fakeDeps(toolCallResponse("emit_requirement_report", paraphrased));
    const result = await runRequirementChecker(CTX, [FILE], ["main.py"], false, deps);
    expect(result.requirementResults.map((r) => r.requirement)).toEqual(CTX.requirements);
    expect(result.requirementResults[0]!.met).toBe(true);
  });

  it("throws after two invalid attempts", async () => {
    const { deps } = fakeDeps(
      toolCallResponse("emit_requirement_report", { requirementResults: [], overallFeedback: "" }),
      textResponse("nope"),
    );
    await expect(runRequirementChecker(CTX, [FILE], ["main.py"], false, deps)).rejects.toMatchObject({
      statusCode: 502,
    });
  });
});

describe("reviewProject", () => {
  const fileIssues = {
    issues: [
      { line: 1, severity: "suggestion", text: "unused import" },
      { line: 4, severity: "error", text: "main() does nothing" },
    ],
  };

  it("assembles per-file counts, badges, score and feedback", async () => {
    const fileWorker = fakeDeps(toolCallResponse("emit_file_review", fileIssues));
    const checker = fakeDeps(toolCallResponse("emit_requirement_report", REPORT));

    const result = await reviewProject(CTX, ingested(), {
      fileWorker: fileWorker.deps,
      requirementChecker: checker.deps,
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ path: "main.py", errors: 1, warnings: 0, suggestions: 1 });
    expect(result.files[0]!.content).toBe(FILE.content);
    expect(result.requirementResults).toHaveLength(2);
    expect(result.overallFeedback).toBe(REPORT.overallFeedback);
    // 1 of 2 requirements met (50*0.6) + code 100-5-0.5=94.5 (*0.4) => 67.8
    expect(result.qualityScore).toBe(68);
    expect(result.truncated).toBe(false);

    // README.md is in the tree though it was never reviewed; main.py is badged.
    expect(result.fileTree.map((n) => n.name)).toEqual(["main.py", "README.md"]);
    expect(result.fileTree[0]!.badge).toBe(2);
    expect(result.fileTree[1]!.badge).toBeUndefined();
  });

  it("ships the review when a file worker fails", async () => {
    const fileWorker = fakeDeps(textResponse("no"), textResponse("still no"));
    const checker = fakeDeps(toolCallResponse("emit_requirement_report", REPORT));

    const result = await reviewProject(CTX, ingested(), {
      fileWorker: fileWorker.deps,
      requirementChecker: checker.deps,
    });

    expect(result.files[0]).toMatchObject({ errors: 0, warnings: 0, suggestions: 0, issues: [] });
    expect(result.overallFeedback).toBe(REPORT.overallFeedback);
  });

  it("fails the review when the requirement checker fails", async () => {
    const fileWorker = fakeDeps(toolCallResponse("emit_file_review", fileIssues));
    const checker = fakeDeps(textResponse("no"), textResponse("still no"));

    await expect(
      reviewProject(CTX, ingested(), { fileWorker: fileWorker.deps, requirementChecker: checker.deps }),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("keeps file order and carries truncation through", async () => {
    const second = { path: "util.py", language: "python", content: "x = 1\n" };
    const fileWorker = fakeDeps(
      toolCallResponse("emit_file_review", { issues: [] }),
      toolCallResponse("emit_file_review", { issues: [] }),
    );
    const checker = fakeDeps(toolCallResponse("emit_requirement_report", REPORT));

    const result = await reviewProject(CTX, ingested([FILE, second], { truncated: true }), {
      fileWorker: fileWorker.deps,
      requirementChecker: checker.deps,
    });

    expect(result.files.map((f) => f.path)).toEqual(["main.py", "util.py"]);
    expect(result.truncated).toBe(true);
  });
});
