import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { ProjectModel } from "../src/database/models/project.model.js";
import { ProjectProgressModel } from "../src/database/models/projectProgress.model.js";
import { createCourse } from "../src/services/course.service.js";
import { completeLesson } from "../src/services/progress.service.js";
import { startProject, submitProject } from "../src/services/projectProgress.service.js";

/**
 * The submission clock on a project, and where it starts.
 *
 * Whether a project is LOCKED stays derived from the student's completed
 * lessons (projectGate, tested separately as a pure function). What is stored
 * here is only WHEN it became available — the one fact a deadline needs, and
 * the one fact nothing else in the system timestamps. Every assertion below is
 * about that seam.
 */

let mongo: MongoMemoryServer;
let userId: string;
let token: string;
let courseId: string;
let lessons: string[];
let timedId: string;
let untimedId: string;

const DAY_MS = 24 * 60 * 60 * 1000;
const auth = () => ({ Authorization: `Bearer ${token}` });
const rowFor = (projectId: string) =>
  ProjectProgressModel.findOne({ userId: new Types.ObjectId(userId), projectId }).lean();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const reg = await request(app).post("/api/auth/register").send({
    name: "Deadline Student",
    username: "deadlinestudent",
    email: "deadline@example.com",
    password: "supersecret123",
  });
  token = reg.body.data.accessToken;
  userId = reg.body.data.user.id;

  const course = await createCourse(userId, {
    title: "Build Things",
    chapters: [
      {
        title: "Basics",
        modules: [
          {
            title: "M",
            topics: [
              { title: "Variables", lessonId: "ignored-1" },
              { title: "Loops", lessonId: "ignored-2" },
            ],
          },
        ],
      },
    ],
  });
  courseId = String(course._id);
  lessons = course.chapters![0]!.modules[0]!.topics.map((t) => t.lessonId);

  const [timed, untimed] = await ProjectModel.create([
    {
      userId: new Types.ObjectId(userId),
      courseId,
      title: "Timed Build",
      chapterIndex: 0,
      unlockLessonId: lessons[0],
      submitWithinDays: 7,
    },
    {
      userId: new Types.ObjectId(userId),
      courseId,
      title: "Untimed Build",
      chapterIndex: 0,
      unlockLessonId: lessons[0],
      submitWithinDays: 0,
    },
  ]);
  timedId = String(timed!._id);
  untimedId = String(untimed!._id);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("the submission clock", () => {
  it("does not exist before the lesson that opens the project is done", async () => {
    expect(await rowFor(timedId)).toBeNull();
  });

  it("starts when that lesson is finished, and only for a project that has a deadline", async () => {
    const at = Date.now();
    await completeLesson(userId, courseId, lessons[0]!);

    const row = await rowFor(timedId);
    expect(row?.status).toBe("unlocked");
    expect(row?.unlockedAt).toBeInstanceOf(Date);
    // Seven days from the moment they finished it, not from when the course was
    // made: the clock is per-student, which is why it is stored as a duration
    // on the project and a date here.
    const due = row!.dueAt!.getTime() - at;
    expect(due).toBeGreaterThan(6.9 * DAY_MS);
    expect(due).toBeLessThan(7.1 * DAY_MS);

    // `submitWithinDays: 0` means no deadline, so there is nothing to record —
    // and a row that exists only to hold a clock it does not have would read as
    // a project the student had already opened.
    expect(await rowFor(untimedId)).toBeNull();
  });

  it("does not restart when the same lesson is completed again", async () => {
    const before = (await rowFor(timedId))!.dueAt!.getTime();
    await new Promise((r) => setTimeout(r, 20));
    await completeLesson(userId, courseId, lessons[0]!);
    expect((await rowFor(timedId))!.dueAt!.getTime()).toBe(before);
  });

  /**
   * The row already exists, carrying the clock and nothing else. Starting the
   * project has to promote it — an insert-only upsert would leave it saying
   * "unlocked" after the student had started, which the course page reads as
   * not started.
   */
  it("promotes the clock row when the student actually starts", async () => {
    await startProject(userId, timedId);
    const row = await rowFor(timedId);
    expect(row?.status).toBe("in_progress");
    // The instant it opened survives, so the deadline does not move.
    expect(row?.dueAt).toBeInstanceOf(Date);
  });

  it("does not drag an archived project back into progress", async () => {
    await ProjectProgressModel.updateOne(
      { userId: new Types.ObjectId(userId), projectId: timedId },
      { $set: { status: "archived" } },
    );
    await startProject(userId, timedId);
    expect((await rowFor(timedId))?.status).toBe("archived");
  });

  it("reports the deadline on the course page, and stops calling it overdue once handed in", async () => {
    await ProjectProgressModel.updateOne(
      { userId: new Types.ObjectId(userId), projectId: timedId },
      { $set: { status: "in_progress", dueAt: new Date(Date.now() - DAY_MS) } },
    );

    const overdue = await request(app).get(`/api/courses/${courseId}/detail`).set(auth());
    const late = overdue.body.data.projects.find((p: { _id: string }) => p._id === timedId);
    expect(late.overdue).toBe(true);
    expect(late.dueAt).toBeTruthy();

    // Handing it in late is still handing it in. A finished project carrying a
    // red "overdue" badge forever is a punishment, not information.
    await submitProject(userId, timedId, "github", "https://github.com/x/y");
    const done = await request(app).get(`/api/courses/${courseId}/detail`).set(auth());
    const row = done.body.data.projects.find((p: { _id: string }) => p._id === timedId);
    expect(row.status).toBe("completed");
    expect(row.overdue).toBe(false);
  });

  it("reads a clock-only row as not started", async () => {
    // "unlocked" exists so a deadline can be recorded for a project nobody has
    // touched. Everything downstream still has to see the state it has always
    // seen, or every card would gain a fourth word for "not started".
    await ProjectProgressModel.updateOne(
      { userId: new Types.ObjectId(userId), projectId: timedId },
      { $set: { status: "unlocked" } },
    );
    const res = await request(app).get(`/api/courses/${courseId}/detail`).set(auth());
    const row = res.body.data.projects.find((p: { _id: string }) => p._id === timedId);
    expect(row.status).toBe("not_started");
  });
});
