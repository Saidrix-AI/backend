import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Three fixes to how courses are planned and built (2026-09-28):
 *
 *  · setup is ONE lesson, first in chapter 1 — a Python course once opened with
 *    a ten-lesson setup chapter (install, terminal, REPL, virtual environments);
 *  · the Courses page shows a path's courses that were proposed but not built
 *    yet, so a 10-course career path is visible even on a 3-course plan;
 *  · building one of those is idempotent and metered — a step that already has
 *    its course returns it, and the monthly limit is checked before any model call.
 *
 * Billing must be configured for the quota check to run at all.
 */
process.env.LEMONSQUEEZY_API_KEY = "test-api-key";
process.env.LEMONSQUEEZY_STORE_ID = "1";
process.env.LEMONSQUEEZY_WEBHOOK_SECRET = "test-signing-secret";

const { ENTITLEMENTS } = await import("../src/config/entitlements.js");
const { CourseModel } = await import("../src/database/models/course.model.js");
const { LearningPathModel } = await import("../src/database/models/learningPath.model.js");
const { UserModel } = await import("../src/database/models/user.model.js");
const { UsageEventModel } = await import("../src/database/models/usageEvent.model.js");
const { listPathsWithCourses } = await import("../src/services/learningPath.service.js");
const { recordCourseGenerated } = await import("../src/services/quota.service.js");
const { makePathCourse } = await import("../src/agents/course-maker/request.js");
const { insertSetupLesson } = await import("../src/agents/course-maker/expand.js");

let mongo: MongoMemoryServer;
let userId: string;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    CourseModel.deleteMany({}),
    LearningPathModel.deleteMany({}),
    UserModel.deleteMany({}),
    UsageEventModel.deleteMany({}),
  ]);
  const user = await UserModel.create({
    name: "Planner",
    username: `planner-${Date.now()}`,
    email: `planner-${Date.now()}@example.com`,
    passwordHash: "x",
    plan: "basic",
    planStatus: "active",
  });
  userId = String(user._id);
});

// ------------------------------------------------------------ the setup lesson

function outline(setupLesson?: { title: string; brief: string }) {
  return {
    title: "Python Fundamentals",
    desc: "d",
    whyTake: "",
    outcomes: [],
    level: "Beginner" as const,
    estimatedHours: 10,
    icon: "python" as const,
    thumb: "dark" as const,
    chapters: [
      { title: "Values and Variables", brief: "b" },
      { title: "Control Flow", brief: "b" },
    ],
    quizzes: [],
    ...(setupLesson ? { setupLesson } : {}),
  };
}

function chapter(titles: string[]) {
  return {
    summary: "s",
    outcomes: ["o"],
    estimatedHours: 1,
    difficulty: "Beginner" as const,
    modules: [
      {
        title: "M",
        summary: "m",
        topics: titles.map((title) => ({ title, summary: "s", brief: "b", durationMin: 15 })),
      },
    ],
  };
}

describe("insertSetupLesson", () => {
  it("puts ONE setup lesson first in chapter 1 and removes the writer's own install lessons", () => {
    const written = [chapter(["Installing Python on Windows", "Your First Variable", "Set up a virtual env"])];
    insertSetupLesson(
      outline({ title: "Install Python and VS Code", brief: "Python + VS Code, run hello.py" }),
      { needsSetupLesson: true, language: "en" },
      written,
    );
    const lessons = written[0]!.modules.flatMap((m) => m.topics.map((t) => t.title));
    expect(lessons).toEqual(["Install Python and VS Code", "Your First Variable"]);
    expect(written[0]!.modules[0]!.topics).toHaveLength(1);
  });

  it("strips Bangla install lessons too", () => {
    const written = [chapter(["Python ইনস্টল ও যাচাই", "প্রথম variable"])];
    insertSetupLesson(outline(), { needsSetupLesson: true, language: "bn" }, written);
    const lessons = written[0]!.modules.flatMap((m) => m.topics.map((t) => t.title));
    expect(lessons).toHaveLength(2);
    expect(lessons[1]).toBe("প্রথম variable");
    expect(written[0]!.modules[0]!.title).toBe("শুরু করার প্রস্তুতি");
  });

  it("does nothing when the student already has a setup", () => {
    const written = [chapter(["Your First Variable"])];
    insertSetupLesson(outline(), { needsSetupLesson: false }, written);
    expect(written[0]!.modules).toHaveLength(1);
  });

  it("still gives the student the setup lesson when chapter 1's writer failed", () => {
    const written: (ReturnType<typeof chapter> | null)[] = [null, chapter(["Loops"])];
    insertSetupLesson(outline(), { needsSetupLesson: true, language: "en" }, written);
    expect(written[0]!.modules[0]!.topics).toHaveLength(1);
  });
});

// ------------------------------------------------------ planned steps on a path

async function makePath(n: number) {
  const path = await LearningPathModel.create({
    userId: new Types.ObjectId(userId),
    goal: "Become a web developer",
    courses: Array.from({ length: n }, (_, i) => ({
      title: `Course ${i + 1}`,
      objective: `Objective ${i + 1}`,
      level: "Beginner",
    })),
  });
  return String(path._id);
}

async function makeCourse(pathId: string, order: number) {
  const c = await CourseModel.create({
    userId: new Types.ObjectId(userId),
    title: `Course ${order}`,
    desc: "d",
    level: "Beginner",
    estimatedHours: 1,
    icon: "code",
    thumb: "dark",
    lessons: 1,
    chapters: [],
    quizzes: [],
    pathId: new Types.ObjectId(pathId),
    pathTitle: "Become a web developer",
    order,
    pathTotal: 8,
  });
  return String(c._id);
}

describe("listPathsWithCourses — the whole path, built or not", () => {
  it("shows the planned steps alongside the built ones, in order", async () => {
    const pathId = await makePath(8);
    await makeCourse(pathId, 1);
    await makeCourse(pathId, 3);

    const [path] = await listPathsWithCourses(userId);
    expect(path!.total).toBe(8);
    expect(path!.steps.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const planned = path!.steps.filter((s) => s.status === "planned");
    expect(planned.map((s) => s.order)).toEqual([2, 4, 5, 6, 7, 8]);
    expect(planned[0]).toMatchObject({ courseId: "", title: "Course 2", objective: "Objective 2" });
  });

  it("still hides a proposal the student never built anything from", async () => {
    await makePath(5);
    expect(await listPathsWithCourses(userId)).toHaveLength(0);
  });
});

describe("makePathCourse", () => {
  it("returns the existing course instead of building (and charging for) a second one", async () => {
    const pathId = await makePath(3);
    const courseId = await makeCourse(pathId, 2);
    const result = await makePathCourse(userId, pathId, 2);
    expect(result).toEqual({ status: "exists", courseId, title: "Course 2" });
    expect(await UsageEventModel.countDocuments({})).toBe(0);
  });

  it("refuses a step the path does not have", async () => {
    const pathId = await makePath(3);
    await expect(makePathCourse(userId, pathId, 9)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("checks the monthly limit before any model call", async () => {
    const pathId = await makePath(3);
    for (let i = 0; i < ENTITLEMENTS.basic.coursesPerMonth; i++) {
      await recordCourseGenerated(userId, `c-${i}`);
    }
    // No LLM is configured in tests: reaching generation would throw something
    // else entirely. The quota error proves the check came first.
    await expect(makePathCourse(userId, pathId, 1)).rejects.toMatchObject({ statusCode: 403 });
  });
});
