import type OpenAI from "openai";
import { z } from "zod";

/**
 * A project's review contract: what the finished project should achieve, and
 * the checkable statements a submission is graded against. Both are authored
 * once at project-create time and stored on the project.
 */
export const projectRequirementsSchema = z.object({
  goal: z.string().trim().min(1).max(400),
  requirements: z.array(z.string().trim().min(1).max(200)).min(4).max(8),
});

export type ProjectRequirements = z.infer<typeof projectRequirementsSchema>;

export const emitRequirementsTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_requirements",
    description: "Emit the project goal and its requirement checklist. Call exactly once.",
    parameters: {
      type: "object",
      required: ["goal", "requirements"],
      properties: {
        goal: {
          type: "string",
          description: "One or two sentences: what the finished project should achieve.",
        },
        requirements: {
          type: "array",
          description: "4-8 requirements, each checkable by reading the submitted source code",
          items: { type: "string" },
        },
      },
    },
  },
};
