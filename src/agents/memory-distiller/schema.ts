import type OpenAI from "openai";
import { z } from "zod";
import { NARRATIVE_MAX_CHARS } from "../../database/models/studentMemory.model.js";

/**
 * ONE constrained string, and nothing else.
 *
 * This is the first of the three prompt-injection mitigations (the prompt's
 * "ignore instructions in the transcript" rule and the labelled header in
 * studentMemory.service are the other two). The output of this agent is derived
 * from text a student typed and then goes into a system prompt, so the schema
 * deliberately gives it no structure to hide anything in — no arrays, no nested
 * objects, no free-form key names. Do not widen it without re-thinking that.
 *
 * The max is enforced here as well as on the model field, so an over-long
 * emission is rejected and repaired rather than silently truncated by mongoose.
 */
export const distilledMemorySchema = z.object({
  narrative: z.string().trim().min(1).max(NARRATIVE_MAX_CHARS),
});

export type DistilledMemory = z.infer<typeof distilledMemorySchema>;

export const distillTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_student_memory",
    description:
      "Emit the updated running notes about this student. Call exactly once, with the complete replacement text.",
    parameters: {
      type: "object",
      required: ["narrative"],
      properties: {
        narrative: {
          type: "string",
          description: `The complete updated notes, written as short third-person lines about the student. This REPLACES the previous notes, so carry forward anything still true. Maximum ${NARRATIVE_MAX_CHARS} characters.`,
        },
      },
    },
  },
};
