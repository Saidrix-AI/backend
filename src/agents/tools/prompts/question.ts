import type OpenAI from "openai";

/**
 * The one-off clarifying-question tool as the model sees it. The multi-round
 * knowledge check is a different tool (./assessment.ts) with its own agent.
 * See ../question-tools.ts for the implementation.
 */

export const askQuestionsTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "ask_questions",
    description:
      "Ask the student 1-4 short questions as interactive multiple-choice cards, shown one at a time — like a guided form. Call this INSTEAD of writing questions as plain text; free text can't be clicked. Each element of `questions` MUST be an object with `question` (the text), `header` (a very short label), and `options` (2-4 short strings) — never a bare string. Use any time you'd otherwise ask several clarifying questions. For the pre-course knowledge check use start_knowledge_check instead. Write everything in the student's language.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "1-4 question objects, asked one at a time",
          items: {
            type: "object",
            required: ["question", "header", "options"],
            properties: {
              question: { type: "string", description: "The full question text" },
              header: {
                type: "string",
                description: "Very short label for this question (max ~40 chars), e.g. 'Experience'",
              },
              options: {
                type: "array",
                description: "2-4 short answer choices",
                items: { type: "string" },
              },
              multiSelect: {
                type: "boolean",
                description: "true if the student can pick more than one option (default false)",
              },
            },
          },
        },
      },
      required: ["questions"],
    },
  },
};

/**
 * Sent back when a batch can't be salvaged. Small models emit this nested
 * schema badly, and a worked example recovers them far more reliably than a
 * raw list of zod issues does.
 */
export const ASK_QUESTIONS_RETRY_HINT =
  'ask_questions needs a "questions" array of 1-4 objects, each ' +
  '{"question": string, "header": short label, "options": [2-4 short strings], "multiSelect": false}. ' +
  'Example: {"questions":[{"question":"How much Python have you written?","header":"Experience",' +
  '"options":["None","A little","A lot"]}]}. Call ask_questions again with this exact shape.';

/** Tool message after a batch is shown — keeps the model from restating them. */
export const ASK_QUESTIONS_SHOWN =
  "Questions shown to the student as interactive cards, one at a time. Do NOT restate them as text. " +
  "Wait for the student's answers before continuing.";
