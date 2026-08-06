import type OpenAI from "openai";
import { z } from "zod";

/** Two questions: what they want to achieve, and what "done" looks like for them. */
export const GOAL_QUESTION_COUNT = 2;

export const intakeQuestionSchema = z.object({
  header: z.string().trim().min(1).max(40),
  question: z.string().trim().min(1).max(300),
  options: z.array(z.string().trim().min(1).max(120)).min(2).max(4),
});
export type IntakeQuestion = z.infer<typeof intakeQuestionSchema>;

export const intakeQuestionBatchSchema = z.object({
  questions: z.array(intakeQuestionSchema).min(1).max(3),
});

export const emitIntakeQuestionsTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_intake_questions",
    description: `Emit the ${GOAL_QUESTION_COUNT} opening questions. Call exactly once.`,
    parameters: {
      type: "object",
      required: ["questions"],
      properties: {
        questions: {
          type: "array",
          description: `Exactly ${GOAL_QUESTION_COUNT} multiple-choice questions: one about the goal, one about the target`,
          items: {
            type: "object",
            required: ["header", "question", "options"],
            properties: {
              header: { type: "string", description: "Very short label, e.g. 'Goal' or 'Target'" },
              question: { type: "string", description: "The full question text" },
              options: {
                type: "array",
                description: "2-4 short, concrete answer choices",
                items: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};
