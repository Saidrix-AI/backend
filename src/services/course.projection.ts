import type { Course } from "../database/models/course.model.js";

type Chapters = NonNullable<Course["chapters"]>;

/**
 * Drops each topic's `brief` from a chapter tree on its way to the browser.
 *
 * The brief is the Course-maker's instruction to the lecture writer — it is
 * consumed server-side by the lecture planner and must never reach the student.
 * Stripping it here rather than relying on the frontend to ignore it also keeps
 * it off the wire: at ~700 chars across ~55 lessons it is tens of KB per course
 * of payload that nothing renders.
 */
export function stripTopicBriefs(chapters: Chapters): Chapters {
  return chapters.map((chapter) => ({
    ...chapter,
    modules: (chapter.modules ?? []).map((module) => ({
      ...module,
      topics: (module.topics ?? []).map(({ brief: _brief, ...topic }) => topic),
    })),
  })) as Chapters;
}

/** `stripTopicBriefs` for a whole course document (list endpoints). */
export function stripCourseBriefs<T extends { chapters?: Chapters }>(course: T): T {
  if (!course.chapters?.length) return course;
  return { ...course, chapters: stripTopicBriefs(course.chapters) };
}
