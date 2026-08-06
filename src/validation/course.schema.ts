import { z } from "zod";

// Single source of the course-create contract (docs/superpowers/course-create-contract.md).
// Used by BOTH the POST /api/courses route and the Course-maker agent, so the
// agent provably satisfies the exact same contract as any API client.

export const LEVELS = ["Beginner", "Intermediate", "Advanced"] as const;
export type Level = (typeof LEVELS)[number];

// Icon names the frontend can render (unknown names fall back to a neutral dot).
// Kept in step with frontend/src/components/blocks/{iconRegistry,brandIcons}.js.

/** Generic glyphs — monochrome, safe on any background, including lecture callouts. */
export const ICON_NAMES = [
  "robot", "brain", "cpu", "book", "chart", "code", "database",
  "chat", "globe", "zap", "target", "layers", "mail", "search", "settings",
  "check", "clipboard", "user", "cloud", "lock", "info", "alert", "send",
] as const;

/**
 * Technology brand marks, drawn in that technology's own colours on a matching
 * tinted band. Course and project cards only — a brand mark on a lecture callout
 * would be off-register, and the callout's tone colour would fight it.
 */
export const BRAND_ICON_NAMES = [
  "python", "javascript", "typescript", "java", "cpp", "csharp", "go", "rust",
  "php", "ruby", "swift", "kotlin", "dart",
  "react", "vue", "angular", "svelte", "nextjs", "vite", "html", "css",
  "tailwind", "bootstrap", "figma",
  "node", "express", "django", "flask", "spring", "laravel", "graphql",
  "postgres", "mysql", "mongodb", "sqlite", "redis", "firebase", "supabase",
  "docker", "kubernetes", "git", "github", "linux", "unity", "flutter",
  "tensorflow", "pytorch", "pandas", "numpy", "jupyter", "sklearn",
] as const;

/** What a course or project card may use. */
export const COURSE_ICON_NAMES = [...ICON_NAMES, ...BRAND_ICON_NAMES] as const;

export const THUMBS = ["dark", "gray", "purple", "green"] as const;

// The detail fields (summary / outcomes / durations) are optional everywhere:
// a client may post a titles-only curriculum exactly as before.
//
// The array caps are sanity ceilings, not design targets — a course is as long
// as its subject needs, and the Course-maker writes one chapter per LLM call so
// nothing forces it to compress. Keep these in step with LIMITS in
// agents/course-maker/schema.ts.
export const topicSchema = z.object({
  title: z.string().min(1).max(160),
  lessonId: z.string().min(1).max(80),
  summary: z.string().max(300).optional(),
  // Instruction for the lecture writer, not the student. Optional like every
  // other detail field, so a titles-only curriculum still posts unchanged.
  brief: z.string().max(700).optional(),
  durationMin: z.number().int().min(0).max(600).optional(),
});
export const moduleSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().max(400).optional(),
  topics: z.array(topicSchema).max(40).default([]),
});
export const chapterSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().max(600).optional(),
  outcomes: z.array(z.string().min(1).max(200)).max(12).optional(),
  estimatedHours: z.number().int().min(0).max(500).optional(),
  difficulty: z.enum(LEVELS).optional(),
  modules: z.array(moduleSchema).max(40).default([]),
});
export const quizSchema = z.object({
  quizId: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
});

export const createCourseSchema = z.object({
  title: z.string().min(1).max(120),
  desc: z.string().max(500).optional(),
  level: z.enum(LEVELS).optional(),
  // Explicit lesson count — honored only when no `chapters` are provided.
  lessons: z.number().int().min(0).max(5000).optional(),
  estimatedHours: z.number().int().min(0).max(5000).optional(),
  icon: z.string().max(40).optional(),
  thumb: z.string().max(20).optional(),
  chapters: z.array(chapterSchema).max(60).optional(),
  quizzes: z.array(quizSchema).max(60).optional(),
});
export type CreateCourseBody = z.infer<typeof createCourseSchema>;
