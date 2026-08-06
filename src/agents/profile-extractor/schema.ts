import type OpenAI from "openai";
import { z } from "zod";
import {
  AGE_BANDS,
  EDUCATION_LEVELS,
  OCCUPATIONS,
  OPERATING_SYSTEMS,
  type ExtractableField,
} from "../../database/models/learnerProfile.model.js";

/**
 * What the extractor is allowed to emit. Every key optional — the normal result
 * is one or two facts, or nothing at all.
 *
 * This mirrors EXTRACTABLE_FIELDS, which is a deliberate subset of the profile:
 * concrete particulars (company, institution, study years) and the student's own
 * self-rating are never inferred from chat. See the note on that constant.
 */
export const extractedFactsSchema = z.object({
  ageBand: z.enum(AGE_BANDS).optional(),
  occupation: z.enum(OCCUPATIONS).optional(),
  operatingSystem: z.enum(OPERATING_SYSTEMS).optional(),
  educationLevel: z.enum(EDUCATION_LEVELS).optional(),
  educationDetail: z.string().trim().min(1).max(80).optional(),
  fieldOfStudy: z.string().trim().min(1).max(80).optional(),
  industry: z.string().trim().min(1).max(80).optional(),
  roleTitle: z.string().trim().min(1).max(80).optional(),
  experienceYears: z.coerce.number().int().min(0).max(60).optional(),
  learningInterests: z.array(z.string().trim().min(1).max(60)).max(8).optional(),
  careerGoal: z.string().trim().min(1).max(200).optional(),
  weeklyHours: z.coerce.number().int().min(0).max(80).optional(),
  preferredStyle: z.string().trim().min(1).max(200).optional(),
  biggestBlocker: z.string().trim().min(1).max(200).optional(),
});

export type ExtractedFacts = z.infer<typeof extractedFactsSchema>;

const FIELD_PROPERTIES: Record<ExtractableField, Record<string, unknown>> = {
  ageBand: { type: "string", enum: [...AGE_BANDS] },
  occupation: { type: "string", enum: [...OCCUPATIONS] },
  operatingSystem: {
    type: "string",
    enum: [...OPERATING_SYSTEMS],
    description:
      "The computer they work on, only when they actually said so (\"I'm on a Mac\", \"my Windows laptop\"). " +
      "Never inferred from the technology they are learning.",
  },
  educationLevel: { type: "string", enum: [...EDUCATION_LEVELS] },
  educationDetail: {
    type: "string",
    description: 'Class, year or degree exactly as they said it, e.g. "3rd year CSE", "Class 9".',
  },
  fieldOfStudy: { type: "string", description: "Subject they study, e.g. Computer Science." },
  industry: { type: "string", description: "Industry they work in, e.g. Fintech." },
  roleTitle: { type: "string", description: "Job title, e.g. Backend Engineer." },
  experienceYears: { type: "integer", description: "Whole years of working experience." },
  learningInterests: {
    type: "array",
    items: { type: "string" },
    description: "Broad areas they want to learn, not one-off questions they asked.",
  },
  careerGoal: { type: "string", description: "What they want this to lead to." },
  weeklyHours: { type: "integer", description: "Hours a week they can study." },
  preferredStyle: { type: "string", description: "How they say they learn best." },
  biggestBlocker: {
    type: "string",
    description: "What they say is holding their learning back, e.g. no time, weak basics.",
  },
};

/**
 * The tool schema, built for only the fields still missing. Narrowing it this way
 * does more than save tokens: a model shown a field it cannot fill is much more
 * likely to invent a plausible value for it.
 */
export function buildExtractTool(
  fields: ExtractableField[],
): OpenAI.Chat.ChatCompletionFunctionTool {
  const properties: Record<string, unknown> = {};
  for (const field of fields) properties[field] = FIELD_PROPERTIES[field];

  return {
    type: "function",
    function: {
      name: "emit_profile_facts",
      description:
        "Record facts the student stated about themselves. Omit every field they did not clearly state.",
      parameters: { type: "object", properties, required: [] },
    },
  };
}
