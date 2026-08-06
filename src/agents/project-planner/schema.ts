import type OpenAI from "openai";
import { z } from "zod";
import { COURSE_ICON_NAMES } from "../../validation/course.schema.js";

/** Progression tiers: warm-up → applied practice → the course's capstone build. */
export const PROJECT_TIERS = ["starter", "practice", "capstone"] as const;
export type ProjectTier = (typeof PROJECT_TIERS)[number];

/** How many projects a course should end up with. */
export const TARGET_PROJECTS = { min: 8, max: 10 } as const;
/** Below this the plan is rejected and the model gets one repair round. */
export const MIN_ACCEPTABLE_PROJECTS = 6;

export const plannedProjectSchema = z.object({
  title: z.string().trim().min(1).max(120),
  desc: z.string().trim().min(1).max(500),
  goal: z.string().trim().min(1).max(400),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
  icon: z.enum(COURSE_ICON_NAMES).catch("robot"),
  /** 1-based chapter number as the model sees it; normalised in index.ts. */
  chapterNumber: z.number().int().min(1).max(30),
  difficulty: z.enum(PROJECT_TIERS).catch("practice"),
  estimatedHours: z.number().int().min(1).max(200).catch(4),
});
export type PlannedProject = z.infer<typeof plannedProjectSchema>;

export const projectPlanSchema = z.object({
  projects: z.array(plannedProjectSchema).max(12),
});

export const emitProjectPlanTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_project_plan",
    description: `Emit the course's hands-on projects. Call exactly once with ${TARGET_PROJECTS.min}-${TARGET_PROJECTS.max} projects.`,
    parameters: {
      type: "object",
      required: ["projects"],
      properties: {
        projects: {
          type: "array",
          description: `${TARGET_PROJECTS.min}-${TARGET_PROJECTS.max} projects, ordered easiest to hardest`,
          items: {
            type: "object",
            required: ["title", "desc", "goal", "tags", "chapterNumber", "difficulty", "estimatedHours"],
            properties: {
              title: { type: "string", description: "Concrete project name, not a topic name" },
              desc: { type: "string", description: "1-2 sentences on what the student builds" },
              goal: {
                type: "string",
                description: "What the finished project must achieve — the reviewer grades against this",
              },
              tags: { type: "array", items: { type: "string" }, description: "2-6 short tech tags" },
              icon: { type: "string", enum: [...COURSE_ICON_NAMES] },
              chapterNumber: {
                type: "integer",
                description: "The chapter number whose skills this project applies (1-based)",
              },
              difficulty: {
                type: "string",
                enum: [...PROJECT_TIERS],
                description: "starter for early warm-ups, practice for the middle, capstone for the final builds",
              },
              estimatedHours: { type: "integer", description: "Realistic build time in hours" },
            },
          },
        },
      },
    },
  },
};
