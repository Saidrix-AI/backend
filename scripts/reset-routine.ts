// One-off: clear all routine items so the reference seed regenerates on next load.
import { connectDatabase, disconnectDatabase } from "../src/database/connect.js";
import { RoutineItemModel } from "../src/database/models/routineItem.model.js";

await connectDatabase();
const res = await RoutineItemModel.deleteMany({});
// eslint-disable-next-line no-console
console.log(`Deleted ${res.deletedCount} routine items.`);
await disconnectDatabase();
