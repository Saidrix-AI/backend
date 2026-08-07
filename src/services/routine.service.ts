import { Types } from "mongoose";
import { RoutineItemModel, type RoutineItem } from "../database/models/routineItem.model.js";
import { ApiError } from "../utils/apiError.js";

export async function listRoutineItems(userId: string) {
  return RoutineItemModel.find({ userId }).sort({ date: 1, createdAt: 1 }).lean();
}

export interface RoutineItemInput {
  type: "class" | "task" | "project";
  title: string;
  subtitle?: string;
  date: string;
  time?: string;
  durationMin?: number;
  tag?: string;
  deadline?: string;
  completed?: boolean;
}

export async function createRoutineItem(userId: string, input: RoutineItemInput) {
  const item = await RoutineItemModel.create({
    userId: new Types.ObjectId(userId),
    ...input,
    date: new Date(input.date),
    deadline: input.deadline ? new Date(input.deadline) : undefined,
  });
  return item.toObject();
}

/** Batch insert — used to build a multi-day study plan in one call. */
export async function createRoutineItems(userId: string, inputs: RoutineItemInput[]) {
  const uid = new Types.ObjectId(userId);
  const docs = inputs.map((input) => ({
    userId: uid,
    ...input,
    date: new Date(input.date),
    deadline: input.deadline ? new Date(input.deadline) : undefined,
  }));
  const created = await RoutineItemModel.insertMany(docs);
  return created.map((d) => d.toObject());
}

async function findOwned(userId: string, id: string) {
  if (!Types.ObjectId.isValid(id)) throw new ApiError(400, "Invalid item id");
  const item = await RoutineItemModel.findOne({ _id: id, userId });
  if (!item) throw new ApiError(404, "Routine item not found");
  return item;
}

export async function updateRoutineItem(
  userId: string,
  id: string,
  patch: Partial<RoutineItemInput>,
) {
  const item = await findOwned(userId, id);
  const { date, deadline, ...rest } = patch;
  Object.assign(item, rest);
  if (date !== undefined) item.date = new Date(date);
  if (deadline !== undefined) item.deadline = deadline ? new Date(deadline) : null;
  await item.save();
  return item.toObject();
}

export async function deleteRoutineItem(userId: string, id: string) {
  await findOwned(userId, id);
  await RoutineItemModel.deleteOne({ _id: id, userId });
}

/**
 * Deletes many items in ONE operation, and reports how many actually went.
 *
 * Exists because "clear my routine" had no way to happen: the only delete took
 * a single id, so emptying a 50-item schedule meant fifty tool calls, which the
 * chat agent's destructive-call cap (correctly) refuses to run. One call for
 * one intent is both safer and the only shape the cap can allow.
 *
 * `userId` is part of the filter rather than checked per item — a caller
 * passing someone else's ids deletes nothing rather than erroring, and there is
 * no lookup to race against in between.
 */
export async function deleteRoutineItems(userId: string, ids: string[]): Promise<number> {
  const valid = ids.filter((id) => Types.ObjectId.isValid(id));
  if (valid.length === 0) return 0;
  const res = await RoutineItemModel.deleteMany({ _id: { $in: valid }, userId });
  return res.deletedCount ?? 0;
}
