import type OpenAI from "openai";
import { z } from "zod";

export const SEVERITIES = ["error", "warning", "suggestion"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * One line-anchored remark from a file worker. `line` is validated against the
 * real file length by fileReviewSchemaFor — a fix pinned to a line that does
 * not exist is worse than no fix at all.
 */
const issueSchema = z.object({
  line: z.number().int().min(1),
  severity: z.enum(SEVERITIES),
  text: z.string().trim().min(1).max(300),
  why: z.string().trim().max(500).default(""),
  fix: z.string().max(800).default(""),
  learn: z.string().trim().max(120).default(""),
});

export type ReviewIssue = z.infer<typeof issueSchema>;

/** Per-file worker output, bound to the file it reviewed. */
export function fileReviewSchemaFor(lineCount: number) {
  return z.object({
    issues: z
      .array(issueSchema)
      .max(30)
      .superRefine((issues, ctx) => {
        issues.forEach((issue, i) => {
          if (issue.line > lineCount) {
            ctx.addIssue({
              code: "custom",
              path: [i, "line"],
              message: `line ${issue.line} is past the end of the file (it has ${lineCount} lines)`,
            });
          }
        });
      }),
  });
}

export const requirementResultSchema = z.object({
  requirement: z.string().trim().min(1),
  met: z.boolean(),
  evidence: z.string().trim().max(400).default(""),
});

export type RequirementResult = z.infer<typeof requirementResultSchema>;

/** Requirement-checker output, bound to the checklist it was asked about. */
export function requirementReportSchemaFor(requirements: string[]) {
  return z.object({
    requirementResults: z
      .array(requirementResultSchema)
      .length(requirements.length, `emit exactly ${requirements.length} results, one per requirement, in order`),
    overallFeedback: z.string().trim().min(1).max(1200),
  });
}

export const emitFileReviewTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_file_review",
    description: "Emit every issue found in this one file. Call exactly once, with an empty list if the file is fine.",
    parameters: {
      type: "object",
      required: ["issues"],
      properties: {
        issues: {
          type: "array",
          description: "Line-anchored issues, ordered by line number",
          items: {
            type: "object",
            required: ["line", "severity", "text"],
            properties: {
              line: { type: "integer", description: "The line number shown in the listing" },
              severity: {
                type: "string",
                enum: [...SEVERITIES],
                description: "error = broken/unsafe; warning = risky or wrong-in-some-cases; suggestion = style/clarity",
              },
              text: { type: "string", description: "One sentence naming the problem" },
              why: { type: "string", description: "One or two sentences on why it matters" },
              fix: { type: "string", description: "The corrected code only — no prose, no markdown fences" },
              learn: { type: "string", description: "Short name of the concept to read up on" },
            },
          },
        },
      },
    },
  },
};

export const emitRequirementReportTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_requirement_report",
    description: "Judge every requirement against the submitted code and give overall feedback. Call exactly once.",
    parameters: {
      type: "object",
      required: ["requirementResults", "overallFeedback"],
      properties: {
        requirementResults: {
          type: "array",
          description: "One result per requirement, in the order given",
          items: {
            type: "object",
            required: ["requirement", "met", "evidence"],
            properties: {
              requirement: { type: "string", description: "The requirement, copied verbatim" },
              met: { type: "boolean" },
              evidence: {
                type: "string",
                description: "Where in the code it is met (file and line), or what is missing",
              },
            },
          },
        },
        overallFeedback: {
          type: "string",
          description: "2-4 sentences to the student: what they did well, then what to fix first",
        },
      },
    },
  },
};
