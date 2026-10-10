import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildToolset } from "../src/agents/tools/registry.js";
import { CourseModel } from "../src/database/models/course.model.js";
import { LearningPathModel } from "../src/database/models/learningPath.model.js";
import { ProjectModel } from "../src/database/models/project.model.js";
import { RoutineItemModel } from "../src/database/models/routineItem.model.js";
import { UserModel } from "../src/database/models/user.model.js";
import { createCourse } from "../src/services/course.service.js";
import { createRoutineItem } from "../src/services/routine.service.js";

let mongo: MongoMemoryServer;

const userA = new Types.ObjectId().toString();
const userB = new Types.ObjectId().toString();
const tools = buildToolset({ userId: userA, searchEnabled: false });

function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return tool.run({ userId: userA }, args);
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("buildToolset", () => {
  it("gates db tools on userId and web search on searchEnabled", () => {
    expect(buildToolset({ searchEnabled: false }).size).toBe(0);
    expect(buildToolset({ userId: userA, searchEnabled: false }).size).toBe(25);
    const withSearch = buildToolset({ userId: userA, searchEnabled: true });
    expect(withSearch.size).toBe(26);
    expect(withSearch.has("create_path_courses")).toBe(true);
    expect(withSearch.has("web_search")).toBe(true);
    // Bulk deletes: without them "delete all my projects" had to be one call
    // per item, which the destructive-call cap refuses — so the request could
    // not be honoured at all.
    expect(withSearch.has("delete_courses")).toBe(true);
    expect(withSearch.has("delete_projects")).toBe(true);
    expect(withSearch.has("delete_routine_items")).toBe(true);
    expect(withSearch.has("generate_course")).toBe(true);
    expect(withSearch.has("propose_courses")).toBe(true);
    expect(withSearch.has("organize_learning_path")).toBe(true);
    expect(withSearch.has("ask_questions")).toBe(true);
    expect(withSearch.has("create_routine_items")).toBe(true);
    expect(withSearch.has("ask_routine_setup")).toBe(true);
    expect(withSearch.has("start_learning_intake")).toBe(true);
    // Folded into the intake's third stage — offering both made the model pick
    // between two overlapping flows.
    expect(withSearch.has("start_knowledge_check")).toBe(false);
  });
});

describe("ask_questions tool", () => {
  const twoQuestions = [
    { question: "Have you programmed before?", header: "Experience", options: ["Never", "A little", "A lot"] },
    { question: "What's your goal?", header: "Goal", options: ["Career switch", "Curiosity"], multiSelect: true },
  ];

  it("returns the questions payload", async () => {
    const outcome = await run("ask_questions", { questions: twoQuestions });
    expect(outcome.ok).toBe(true);
    expect(outcome.label).toBe("Asked 2 questions");
    expect(outcome.questions).toHaveLength(2);
    expect(outcome.questions![0]).toMatchObject({ header: "Experience", options: ["Never", "A little", "A lot"] });
    expect(outcome.questions![1].multiSelect).toBe(true);
    expect(outcome.modelText).toContain("Do NOT restate them as text");
  });

  // Small models emit this schema badly, so the tool normalizes what it can
  // (see normalizeQuestions) and answers an unusable batch with a re-call hint
  // rather than a zod dump.
  it("rejects an empty batch with a re-call hint", async () => {
    const zero = await run("ask_questions", { questions: [] });
    expect(zero.ok).toBe(false);
    expect(zero.modelText).toContain('needs a "questions" array');
  });

  it("trims an over-long batch to 4 questions", async () => {
    const five = await run("ask_questions", {
      questions: Array.from({ length: 5 }, (_, i) => ({
        question: `Q${i}`,
        header: `H${i}`,
        options: ["A", "B"],
      })),
    });
    expect(five.ok).toBe(true);
    expect(five.questions).toHaveLength(4);
  });

  it("drops a question with fewer than 2 options", async () => {
    const outcome = await run("ask_questions", {
      questions: [{ question: "Q", header: "H", options: ["only one"] }],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.modelText).toContain('needs a "questions" array');
  });
});

describe("propose_courses tool", () => {
  const twoCourses = [
    {
      title: "Python Foundations",
      objective: "Python from zero for data work",
      level: "Beginner",
      note: "Start here — foundation for the rest",
    },
    { title: "Data Analysis with Pandas", objective: "Analyze real datasets with pandas" },
  ];

  it("saves an ordered path and returns the proposal payload, creating no course", async () => {
    const before = await CourseModel.countDocuments({});
    const outcome = await run("propose_courses", {
      goal: "Become a Python Dev",
      breadth: "subject",
      courses: twoCourses,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.changed).toBeUndefined();
    expect(outcome.label).toBe("Proposed 2 courses");
    expect(outcome.proposal).toHaveLength(2);
    expect(outcome.proposal![0]).toMatchObject({ title: "Python Foundations", level: "Beginner" });
    // The path is persisted (so generate_course can reference it), but NO course is created yet.
    expect(outcome.modelText).toMatch(/pathId=|generate_course/);
    expect(await CourseModel.countDocuments({})).toBe(before);
  });

  it("requires a breadth — the decision that fixes how many courses the path has", async () => {
    const outcome = await run("propose_courses", { goal: "Python", courses: twoCourses });
    expect(outcome.ok).toBe(false);
    expect(outcome.modelText).toContain("breadth");
  });

  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `C${i}`, objective: `o${i}` }));

  it("holds a single topic to exactly one course", async () => {
    // "Python fundamentals" came back as three courses every time.
    const split = await run("propose_courses", { goal: "Python fundamentals", breadth: "topic", courses: twoCourses });
    expect(split.ok).toBe(false);
    expect(split.modelText).toContain("exactly ONE course");

    const one = await run("propose_courses", {
      goal: "Python fundamentals",
      breadth: "topic",
      courses: twoCourses.slice(0, 1),
    });
    expect(one.ok).toBe(true);
    expect(one.label).toBe("Proposed 1 course");
  });

  it("makes a career path cover the whole syllabus (4-10 courses)", async () => {
    const thin = await run("propose_courses", { goal: "Web developer", breadth: "career", courses: many(3) });
    expect(thin.ok).toBe(false);
    expect(thin.modelText).toContain("4-10");

    const full = await run("propose_courses", { goal: "Web developer", breadth: "career", courses: many(8) });
    expect(full.ok).toBe(true);
    expect(full.proposal).toHaveLength(8);

    const tooMany = await run("propose_courses", { goal: "Web developer", breadth: "career", courses: many(11) });
    expect(tooMany.ok).toBe(false);
  });

  it("keeps a subject to 2-3 courses", async () => {
    const four = await run("propose_courses", { goal: "Data analysis", breadth: "subject", courses: many(4) });
    expect(four.ok).toBe(false);
    expect(four.modelText).toContain("2-3");
  });

  it("rejects a course entry without an objective", async () => {
    const outcome = await run("propose_courses", {
      courses: [{ title: "A", objective: "a" }, { title: "B" }],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.modelText).toContain("Invalid arguments");
  });
});

describe("course tools", () => {
  it("create_course inserts a course owned by the caller", async () => {
    const outcome = await run("create_course", {
      title: "React Basics",
      level: "Beginner",
      lessons: 10,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.changed).toBe("course");
    expect(outcome.label).toContain("React Basics");

    const docs = await CourseModel.find({ userId: userA });
    expect(docs).toHaveLength(1);
    expect(String(docs[0].userId)).toBe(userA);
  });

  it("rejects invalid args without throwing", async () => {
    const outcome = await run("create_course", { desc: "no title" });
    expect(outcome.ok).toBe(false);
    expect(outcome.modelText).toContain("Invalid arguments");
  });

  it("update_course cannot touch another user's course", async () => {
    const foreign = await createCourse(userB, { title: "Other's Course" });
    const outcome = await run("update_course", {
      courseId: String(foreign._id),
      title: "Hijacked",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.modelText).toContain("not found");

    const untouched = await CourseModel.findById(foreign._id);
    expect(untouched?.title).toBe("Other's Course");
  });

  it("delete_course with a malformed id fails cleanly", async () => {
    const outcome = await run("delete_course", { courseId: "not-an-objectid" });
    expect(outcome.ok).toBe(false);
  });

  it("delete_course removes an owned course and names it", async () => {
    const course = await createCourse(userA, { title: "Doomed Course" });
    const outcome = await run("delete_course", { courseId: String(course._id) });
    expect(outcome.ok).toBe(true);
    expect(outcome.label).toContain("Doomed Course");
    expect(await CourseModel.findById(course._id)).toBeNull();
  });

  it("list_courses reports titles and ids", async () => {
    const outcome = await run("list_courses");
    expect(outcome.ok).toBe(true);
    expect(outcome.modelText).toContain("React Basics");
    expect(outcome.modelText).toContain("id:");
  });
});

describe("routine tools", () => {
  // create_routine_items refuses a batch whose earliest date is in the past, so
  // any fixture with literal future dates rots the day it arrives. Date the
  // batches relative to today instead. (Single-item tests below are exempt —
  // create_routine_item has no past-date guard.)
  const dayFromToday = (offset: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  it("rejects an unparseable date", async () => {
    const outcome = await run("create_routine_item", {
      type: "class",
      title: "Physics",
      date: "kalke sokale",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.modelText).toContain("Invalid arguments");
  });

  it("creates an item with a real Date", async () => {
    const outcome = await run("create_routine_item", {
      type: "class",
      title: "Physics class",
      date: "2026-07-16",
      time: "09:00 AM",
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.changed).toBe("routine");

    const item = await RoutineItemModel.findOne({ userId: userA, title: "Physics class" });
    expect(item?.date).toBeInstanceOf(Date);
    expect(item?.date.toISOString().slice(0, 10)).toBe("2026-07-16");
  });

  it("update_routine_item can mark an item completed", async () => {
    const item = await createRoutineItem(userA, {
      type: "task",
      title: "Finish homework",
      date: "2026-07-17",
    });
    const outcome = await run("update_routine_item", {
      itemId: String(item._id),
      completed: true,
    });
    expect(outcome.ok).toBe(true);

    const updated = await RoutineItemModel.findById(item._id);
    expect(updated?.completed).toBe(true);
  });

  it("update_routine_item requires at least one change", async () => {
    const item = await createRoutineItem(userA, {
      type: "task",
      title: "Lonely item",
      date: "2026-07-18",
    });
    const outcome = await run("update_routine_item", { itemId: String(item._id) });
    expect(outcome.ok).toBe(false);
    expect(outcome.modelText).toContain("Invalid arguments");
  });

  it("create_routine_items batch-inserts a multi-day study plan", async () => {
    const dates = Array.from({ length: 5 }, (_, i) => dayFromToday(i));
    const items = dates.map((date, i) => ({
      type: "task",
      title: `Python for Data Analysis - Lesson ${i + 1}`,
      date,
    }));
    const outcome = await run("create_routine_items", { items });
    expect(outcome.ok).toBe(true);
    expect(outcome.changed).toBe("routine");
    expect(outcome.label).toContain("5 items");
    expect(outcome.modelText).toContain(dates[0]);
    expect(outcome.modelText).toContain(dates[4]);

    const saved = await RoutineItemModel.countDocuments({
      userId: userA,
      title: /Python for Data Analysis - Lesson/,
    });
    expect(saved).toBe(5);
  });

  // gpt-4o-mini dated a 2026 study plan across 2023 — a plan in the past never
  // shows up on the routine page, so the server (which knows today) makes the
  // model retry instead of saving something useless.
  it("create_routine_items rejects a plan dated in the past and says today's date", async () => {
    const outcome = await run("create_routine_items", {
      items: [
        { type: "task", title: "Stale - Lesson 1", date: "2023-07-25" },
        { type: "task", title: "Stale - Lesson 2", date: "2023-07-26" },
      ],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.modelText).toContain("2023-07-25");
    expect(outcome.modelText).toContain(new Date().toISOString().slice(0, 10));
    expect(await RoutineItemModel.countDocuments({ userId: userA, title: /^Stale/ })).toBe(0);
  });

  it("still accepts a plan starting today", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const outcome = await run("create_routine_items", {
      items: [{ type: "task", title: "Fresh - Lesson 1", date: today }],
    });
    expect(outcome.ok).toBe(true);
  });

  it("create_routine_items rejects an empty list or a bad date", async () => {
    const empty = await run("create_routine_items", { items: [] });
    expect(empty.ok).toBe(false);
    expect(empty.modelText).toContain("Invalid arguments");

    const badDate = await run("create_routine_items", {
      items: [{ type: "task", title: "X", date: "next week" }],
    });
    expect(badDate.ok).toBe(false);
  });
});

// The setup cards are built by the server from the student's own courses, so
// what the model can get wrong is limited to the (optional) courseTitle hint.
describe("ask_routine_setup tool", () => {
  const scheduler = new Types.ObjectId().toString();
  const schedulerTools = buildToolset({ userId: scheduler, searchEnabled: false });
  const setup = (args: Record<string, unknown> = {}) =>
    schedulerTools.get("ask_routine_setup")!.run({ userId: scheduler }, args);

  it("asks nothing when the student has no courses", async () => {
    const outcome = await setup();
    expect(outcome.ok).toBe(true);
    expect(outcome.questions).toBeUndefined();
    expect(outcome.label).toBe("No courses to schedule");
    expect(outcome.modelText).toContain("no courses yet");
  });

  it("skips the course question when the student owns exactly one course", async () => {
    await createCourse(scheduler, { title: "Python Basics", lessons: 12 });
    const outcome = await setup();
    expect(outcome.ok).toBe(true);
    expect(outcome.questions!.map((q) => q.header)).toEqual([
      "Finish by",
      "Study days",
      "Study time",
    ]);
    // Lesson counts travel back to the model so it can date every lesson.
    expect(outcome.modelText).toContain('"Python Basics" (12 lessons)');
    expect(outcome.modelText).toContain("create_routine_items");
  });

  it("asks which course when there are several, offering the real titles", async () => {
    await createCourse(scheduler, { title: "React Fundamentals", lessons: 8 });
    const outcome = await setup();
    expect(outcome.questions).toHaveLength(4);
    const course = outcome.questions![0]!;
    expect(course.header).toBe("Course");
    expect(course.multiSelect).toBe(true);
    expect(course.options).toEqual(expect.arrayContaining(["Python Basics", "React Fundamentals"]));
    expect(outcome.label).toBe("Asked 4 routine questions");
  });

  it("drops the course question when the student already named one (case-insensitively)", async () => {
    const outcome = await setup({ courseTitle: "react fundamentals" });
    expect(outcome.questions!.map((q) => q.header)).toEqual([
      "Finish by",
      "Study days",
      "Study time",
    ]);
  });

  it("still asks which course when the named one isn't theirs", async () => {
    const outcome = await setup({ courseTitle: "Rust for Robots" });
    expect(outcome.questions![0]!.header).toBe("Course");
  });
});

describe("student tools", () => {
  it("get_my_progress works for a user with no data", async () => {
    const emptyUser = new Types.ObjectId().toString();
    const toolset = buildToolset({ userId: emptyUser, searchEnabled: false });
    const outcome = await toolset.get("get_my_progress")!.run({ userId: emptyUser }, {});
    expect(outcome.ok).toBe(true);
    expect(outcome.modelText).toContain("Courses enrolled: 0");
  });

  it("get_my_profile returns safe fields only", async () => {
    const user = await UserModel.create({
      name: "Tool Tester",
      username: "tooltester",
      email: "tool@example.com",
      passwordHash: "hashed-not-real",
    });
    const uid = String(user._id);
    const toolset = buildToolset({ userId: uid, searchEnabled: false });
    const outcome = await toolset.get("get_my_profile")!.run({ userId: uid }, {});
    expect(outcome.ok).toBe(true);
    expect(outcome.modelText).toContain("Tool Tester");
    expect(outcome.modelText).not.toContain("hashed-not-real");
  });
});

describe("organize_learning_path tool", () => {
  it("links existing courses into an ordered, path-stamped roadmap", async () => {
    await CourseModel.deleteMany({});
    await LearningPathModel.deleteMany({});
    const html = await createCourse(userA, {
      title: "HTML",
      level: "Beginner",
      chapters: [{ title: "Document Structure", modules: [{ title: "M", topics: [{ title: "T", lessonId: "l1" }] }] }],
    });
    const css = await createCourse(userA, { title: "CSS", level: "Beginner" });

    const outcome = await run("organize_learning_path", {
      goal: "Front-End Web Dev",
      courseIds: [String(html._id), String(css._id)],
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.changed).toBe("course");

    const path = await LearningPathModel.findOne({ userId: userA }).lean();
    expect(path!.goal).toBe("Front-End Web Dev");
    expect(path!.courses.map((c) => c.title)).toEqual(["HTML", "CSS"]);
    expect(path!.courses[0]!.covers).toContain("Document Structure");

    const htmlDoc = await CourseModel.findById(html._id).lean();
    const cssDoc = await CourseModel.findById(css._id).lean();
    expect(String(htmlDoc!.pathId)).toBe(String(path!._id));
    expect(htmlDoc!.order).toBe(1);
    expect(cssDoc!.order).toBe(2);
    expect(htmlDoc!.pathTotal).toBe(2);
    expect(htmlDoc!.pathTitle).toBe("Front-End Web Dev");
  });

  it("rejects when fewer than two of the ids belong to the student", async () => {
    await CourseModel.deleteMany({});
    const mine = await createCourse(userA, { title: "Only Mine", level: "Beginner" });
    const outcome = await run("organize_learning_path", {
      goal: "Bogus",
      courseIds: [String(mine._id), new Types.ObjectId().toString()],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.modelText).toContain("couldn't find at least two");
  });
});

/**
 * The gap that made "delete all 33 projects" impossible: the only delete tools
 * took a single id, so honouring it meant 33 calls — and the chat agent's
 * destructive-call cap refuses everything past three, leaving the job undone
 * with nothing deleted. One call for one intent is what the cap can allow.
 */
describe("bulk deletes", () => {
  it("removes many projects in one call and reports what actually went", async () => {
    await ProjectModel.deleteMany({});
    const mine = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        ProjectModel.create({ userId: new Types.ObjectId(userA), title: `P${i}` }),
      ),
    );
    const alreadyGone = new Types.ObjectId().toString();

    const outcome = await run("delete_projects", {
      projectIds: [...mine.map((p) => String(p._id)), alreadyGone],
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.changed).toBe("project");
    // Counted from the database, not from the id list — the sixth id was never
    // there, and claiming six deletions would be a lie to the student.
    expect(outcome.label).toBe("5 projects deleted");
    expect(outcome.modelText).toContain("Deleted 5 of the 6");
    expect(await ProjectModel.countDocuments({})).toBe(0);
  });

  it("removes many courses in one call", async () => {
    await CourseModel.deleteMany({});
    const made = await Promise.all([
      createCourse(userA, { title: "One", level: "Beginner" }),
      createCourse(userA, { title: "Two", level: "Beginner" }),
      createCourse(userA, { title: "Three", level: "Beginner" }),
    ]);

    const outcome = await run("delete_courses", { courseIds: made.map((c) => String(c._id)) });

    expect(outcome.ok).toBe(true);
    expect(outcome.label).toBe("3 courses deleted");
    // The student has to hear that a course delete leaves these behind.
    expect(outcome.modelText).toContain("projects and routine items were NOT removed");
    expect(await CourseModel.countDocuments({})).toBe(0);
  });

  it("removes many routine items in one call", async () => {
    await RoutineItemModel.deleteMany({});
    const items = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        createRoutineItem(userA, { type: "class", title: `Lesson ${i}`, date: "2026-09-01" }),
      ),
    );

    const outcome = await run("delete_routine_items", {
      itemIds: items.map((i) => String(i._id)),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.changed).toBe("routine");
    expect(outcome.label).toBe("4 routine items removed");
    expect(await RoutineItemModel.countDocuments({})).toBe(0);
  });

  // The ownership boundary matters more here than anywhere: one call can carry
  // 150 ids, so a filter that trusted them would be a mass-delete primitive.
  it("cannot touch another student's rows, whatever ids are passed", async () => {
    await ProjectModel.deleteMany({});
    await CourseModel.deleteMany({});
    await RoutineItemModel.deleteMany({});

    const theirProject = await ProjectModel.create({
      userId: new Types.ObjectId(userB),
      title: "Not yours",
    });
    const theirCourse = await createCourse(userB, { title: "Not yours", level: "Beginner" });
    const theirItem = await createRoutineItem(userB, {
      type: "class",
      title: "Not yours",
      date: "2026-09-01",
    });

    // userA asking to delete userB's rows.
    const p = await run("delete_projects", { projectIds: [String(theirProject._id)] });
    const c = await run("delete_courses", { courseIds: [String(theirCourse._id)] });
    const r = await run("delete_routine_items", { itemIds: [String(theirItem._id)] });

    // Reported honestly as "nothing went" rather than erroring...
    expect([p.label, c.label, r.label]).toEqual([
      "Nothing to delete",
      "Nothing to delete",
      "Nothing to remove",
    ]);
    // ...and everything is still there.
    expect(await ProjectModel.countDocuments({})).toBe(1);
    expect(await CourseModel.countDocuments({})).toBe(1);
    expect(await RoutineItemModel.countDocuments({})).toBe(1);
  });
})
;
