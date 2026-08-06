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
