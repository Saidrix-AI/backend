import { Types } from "mongoose";
import { BoardModel } from "../database/models/board.model.js";
import { ApiError } from "../utils/apiError.js";
import { requireOwnedLesson } from "./lecture.service.js";

export const MAX_BOARD_ELEMENTS = 2000;
export const MAX_BOARD_BYTES = 3_000_000;

export interface BoardSnapshot {
  rev: number;
  elements: Record<string, unknown>[];
}

/** The student's board for a lesson; an untouched one reads as empty. */
export async function getBoard(userId: string, lessonId: string): Promise<BoardSnapshot> {
  await requireOwnedLesson(userId, lessonId);
  const doc = await BoardModel.findOne({ userId: new Types.ObjectId(userId), lessonId }).lean();
  return {
    rev: doc?.rev ?? 0,
    elements: (doc?.elements as Record<string, unknown>[] | undefined) ?? [],
  };
}

/**
 * Replaces the snapshot — unless it is OLDER than what is stored.
 *
 * The rev guard is the filter of an upsert: a stored doc with a higher rev does
 * not match, the upsert then tries to insert a second doc for the same
 * (user, lesson), and the unique index refuses it. That makes "newer or equal
 * wins" atomic, with no read-then-write race between two saves in flight.
 */
export async function saveBoard(
  userId: string,
  lessonId: string,
  input: BoardSnapshot,
): Promise<{ rev: number }> {
  await requireOwnedLesson(userId, lessonId);
  if (input.elements.length > MAX_BOARD_ELEMENTS) {
    throw new ApiError(413, "This board has too many elements to save");
  }
  if (Buffer.byteLength(JSON.stringify(input.elements)) > MAX_BOARD_BYTES) {
    throw new ApiError(413, "This board is too large to save");
  }
  try {
    await BoardModel.findOneAndUpdate(
      { userId: new Types.ObjectId(userId), lessonId, rev: { $lte: input.rev } },
      { $set: { rev: input.rev, elements: input.elements } },
      { upsert: true, new: true },
    );
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw new ApiError(409, "A newer board is already saved");
    }
    throw err;
  }
  return { rev: input.rev };
}
