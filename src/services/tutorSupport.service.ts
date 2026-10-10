import { Types } from "mongoose";
import { formatSearchForModel, runWebSearch } from "../agents/tools/web-search.js";
import { LecturePositionModel } from "../database/models/lecturePosition.model.js";
import { ApiError } from "../utils/apiError.js";
import { requireOwnedLesson } from "./lecture.service.js";
import { buildStudentContext } from "./studentMemory.service.js";

/**
 * What the live classroom tutor reads and writes beyond the lecture itself:
 * who the student is, its own notes from earlier sessions of this class, and
 * the web. Agent-only routes (routes/lecture.routes.ts); every call is scoped to
 * a lesson the student owns.
 */

export const CLASS_NOTES_MAX = 2000;

/** The student context (identity, mastery, chat narrative) plus this class's earlier notes. */
export async function getTutorContext(userId: string, lessonId: string): Promise<{ student: string; classNotes: string }> {
  await requireOwnedLesson(userId, lessonId);
  const [student, position] = await Promise.all([
    buildStudentContext(userId, { include: ["identity", "mastery", "narrative"] }),
    LecturePositionModel.findOne({ userId: new Types.ObjectId(userId), lessonId }, { classNotes: 1 }).lean(),
  ]);
  return { student, classNotes: position?.classNotes ?? "" };
}

export async function saveClassNotes(userId: string, lessonId: string, notes: string): Promise<void> {
  await requireOwnedLesson(userId, lessonId);
  await LecturePositionModel.updateOne(
    { userId: new Types.ObjectId(userId), lessonId },
    { $set: { classNotes: notes.slice(0, CLASS_NOTES_MAX) } },
    { upsert: true },
  );
}

/** A web search for the tutor, as compact text it can answer from. */
export async function tutorWebSearch(userId: string, lessonId: string, query: string): Promise<string> {
  await requireOwnedLesson(userId, lessonId);
  try {
    const result = await runWebSearch(query, { maxResults: 4 });
    return formatSearchForModel(result);
  } catch (err) {
    throw new ApiError(502, `Web search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
