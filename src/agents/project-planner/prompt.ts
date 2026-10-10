import { BRAND_ICON_NAMES, ICON_NAMES } from "../../validation/course.schema.js";
import { TARGET_PROJECTS } from "./schema.js";

/** Everything the planner knows about the course it is building projects for. */
export interface ProjectPlanContext {
  title: string;
  desc: string;
  level: string;
  objective: string;
  /**
   * Chapters in order with the ground each covers — the skills available by
   * then — and each chapter's lessons, so a project can name the ONE lesson
   * that opens it rather than waiting for the whole chapter.
   *
   * `topics` is empty when the curriculum has not been written yet, and the
   * planner then falls back to chapter-level mapping exactly as it used to.
   */
  chapters: { title: string; covers: string; topics?: string[] }[];
  /** One-line picture of the student from the knowledge assessment, if any. */
  profile?: string;
}

export function buildProjectPlanSystemPrompt(): string {
  return `You are the project planner for Saidrix AI Tutor. Given a course curriculum, you design the hands-on projects the student builds while working through it. You respond ONLY by calling the emit_project_plan function exactly once — never with plain text.

Rules:
- Emit ${TARGET_PROJECTS.min}-${TARGET_PROJECTS.max} projects, ordered easiest to hardest. Fewer than ${TARGET_PROJECTS.min} is not acceptable.
- Every project maps to a chapter (chapterNumber) whose skills it applies. Spread them across the whole course — do not pile them on the last chapter. A project may only use what the student has learned by the end of that chapter.
- Difficulty progression: the first two or three are "starter" (small, one sitting, one new skill each), the middle ones are "practice" (multi-part, combining several chapters), and the last one or two are "capstone" (a real end-to-end build worth putting in a portfolio).
- Each project is something the student BUILDS, with a name a person would actually give it — never a restated lesson title ("Lists Practice") and never a vague exercise ("Practice functions").
- desc: 1-2 sentences on what they build. goal: what the finished thing must achieve — this is the contract a reviewer later grades the submitted code against, so make it concrete and checkable.
- No two projects may be the same idea at different sizes. Vary the domain (data, text, games, tools, APIs) so the set stays interesting.
- tags: 2-6 short technology tags. icon: when the project centres on one technology with a well-known logo, use its brand name — ${BRAND_ICON_NAMES.join(", ")} — which renders in that technology's own colours. Otherwise the most topical generic icon from ${ICON_NAMES.join(", ")}.
- estimatedHours: realistic — a starter is 1-3 hours, a capstone 10-25.
- unlockAfterTopic: when the chapter's lessons are listed, give the number of the EARLIEST lesson after which the student could actually build this. A project that only needs the first three lessons of a chapter should not sit locked until all nine are done — that is nine lessons of theory before anything is built. Leave it out only when the project genuinely needs the whole chapter, or when no lessons are listed.
- submitWithinDays: how long the student should have to hand it in once it opens, counted from when they finish the unlocking lesson. Roughly 3-5 days for a starter, 7-10 for a practice project, 14-21 for a capstone — a deadline that cannot be met is worse than none. Use 0 for no deadline.
- Write everything in the same language as the course title.`;
}

export function buildProjectPlanUserMessage(ctx: ProjectPlanContext): string {
  const chapters = ctx.chapters
    .map((c, i) => {
      const head = `${i + 1}. ${c.title}${c.covers ? ` — covers: ${c.covers}` : ""}`;
      // Numbered within the chapter, because that is what unlockAfterTopic
      // refers to — a number the model can read off the line above it.
      const topics = (c.topics ?? []).map((t, n) => `     ${n + 1}) ${t}`).join("\n");
      return topics ? `${head}\n${topics}` : head;
    })
    .join("\n");

  return [
    `Course: ${ctx.title} (${ctx.level})`,
    `Description: ${ctx.desc}`,
    `Student's objective: ${ctx.objective}`,
    ctx.profile ? `About the student: ${ctx.profile}` : "",
    "",
    "Chapters:",
    chapters,
    "",
    `Call emit_project_plan with ${TARGET_PROJECTS.min}-${TARGET_PROJECTS.max} projects covering this curriculum.`,
  ]
    .filter(Boolean)
    .join("\n");
}
