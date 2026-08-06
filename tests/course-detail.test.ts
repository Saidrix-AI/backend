import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { CourseModel } from "../src/database/models/course.model.js";
import { submitQuiz } from "../src/services/progress.service.js";

let mongo: MongoMemoryServer;
let token: string;
let userId: string;
let courseId: string;
/**
 * The four lessonIds the SERVER assigned, in curriculum order.
 *
 * Lesson ids are not accepted from the client — `lessonId` keys the global
 * Lecture collection, so letting a caller choose one lets it claim another
 * student's lecture namespace (services/course.service.ts#assignCurriculumIds).
 * Whatever this test posts is therefore discarded, and it reads back what it
 * actually got.
 */
let lessons: string[];

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const reg = await request(app).post("/api/auth/register").send({
    name: "Curriculum User",
    username: "curricuser",
    email: "curric@example.com",
    password: "supersecret123",
  });
  token = reg.body.data.accessToken;
  userId = reg.body.data.user.id;

  const created = await request(app).post("/api/courses").set(auth()).send({
    title: "Agents 101",
    desc: "Learn agents",
    level: "Beginner",
    estimatedHours: 10,
    icon: "robot",
    chapters: [
      {
        title: "Basics",
        modules: [
          { title: "Intro", topics: [{ title: "Overview", lessonId: "l1" }, { title: "Setup", lessonId: "l2" }] },
        ],
      },
      {
        title: "Advanced",
        modules: [{ title: "Deep", topics: [{ title: "Tools", lessonId: "l3" }, { title: "Memory", lessonId: "l4" }] }],
      },
    ],
    quizzes: [{ quizId: "q1", title: "Quiz 1" }, { quizId: "q2", title: "Quiz 2" }],
  });
  courseId = created.body.data._id;
  lessons = (created.body.data.chapters as {
    modules: { topics: { lessonId: string }[] }[];
  }[]).flatMap((ch) => ch.modules.flatMap((m) => m.topics.map((t) => t.lessonId)));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("course curriculum + detail", () => {
  it("derives lessons from chapters on create", async () => {
    const list = await request(app).get("/api/courses").set(auth());
    const c = list.body.data.find((x: { _id: string }) => x._id === courseId);
    expect(c.lessons).toBe(4); // 2 + 2 topics
  });

  // The topic brief is the Course-maker's instruction to the lecture writer. It
  // must never reach the student, and the guarantee has to be structural — an
  // earlier version of this codebase relied on the frontend simply not reading
  // the field, and the comments claiming so drifted out of date.
  it("never returns topic.brief from either courses endpoint", async () => {
    const created = await request(app).post("/api/courses").set(auth()).send({
      title: "Brief Carrier",
      chapters: [
        {
          title: "Ch",
          modules: [
            {
              title: "M",
              topics: [{ title: "T", lessonId: "bl1", summary: "shown", brief: "SECRET-WRITER-INSTRUCTION" }],
            },
          ],
        },
      ],
    });
    const id = created.body.data._id;

    // It really is persisted — otherwise this test would pass vacuously.
    const stored = await CourseModel.findById(id).lean();
    expect(stored!.chapters[0]!.modules[0]!.topics[0]!.brief).toBe("SECRET-WRITER-INSTRUCTION");

    const detail = await request(app).get(`/api/courses/${id}/detail`).set(auth());
    const topic = detail.body.data.course.chapters[0].modules[0].topics[0];
    expect(topic.brief).toBeUndefined();
    expect(topic.summary).toBe("shown"); // the sibling field still ships
    expect(JSON.stringify(detail.body)).not.toContain("SECRET-WRITER-INSTRUCTION");

    const list = await request(app).get("/api/courses").set(auth());
    expect(JSON.stringify(list.body)).not.toContain("SECRET-WRITER-INSTRUCTION");
  });

  it("detail reflects enrollment, completion, activity and course achievement", async () => {
    await request(app).post("/api/progress/enroll").set(auth()).send({ courseId });
    await request(app).post("/api/progress/complete-lesson").set(auth()).send({ courseId, lessonId: lessons[0] });

    const res = await request(app).get(`/api/courses/${courseId}/detail`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.progress.lessonsTotal).toBe(4);
    expect(res.body.data.progress.lessonsDone).toBe(1);
    expect(res.body.data.progress.overallPct).toBe(25);
    expect(res.body.data.enrollment).not.toBeNull();
    const types = res.body.data.activity.map((a: { type: string }) => a.type);
    expect(types).toContain("enroll");
    expect(types).toContain("lesson");
    const keys = res.body.data.achievements.map((a: { key: string }) => a.key);
    expect(keys).toContain("first_module");
    expect(keys).toContain("course_25");
  });

  it("links a project by courseId and reflects it in detail", async () => {
    const proj = await request(app).post("/api/projects").set(auth()).send({ title: "Cap", desc: "x", courseId });
    const projectId = proj.body.data._id;
    await request(app).post(`/api/progress/project/${projectId}/submit`).set(auth()).send({ method: "github", value: "https://github.com/x/y" });

    const res = await request(app).get(`/api/courses/${courseId}/detail`).set(auth());
    expect(res.body.data.projects).toHaveLength(1);
    expect(res.body.data.projects[0].status).toBe("completed");
    expect(res.body.data.stats.projectsDone).toBe(1);
  });

  // Assessments are the exam that closes each lesson's lecture, keyed by
  // lessonId — NOT the title-only `course.quizzes` the course-maker invents,
  // which have no questions and no way to be taken.
  it("lists one assessment per lesson, in curriculum order", async () => {
    const res = await request(app).get(`/api/courses/${courseId}/detail`).set(auth());
    const quizzes = res.body.data.quizzes as { quizId: string; title: string; chapterTitle: string }[];

    expect(quizzes.map((q) => q.quizId)).toEqual(lessons);
    expect(quizzes[0]).toMatchObject({ title: "Overview", chapterTitle: "Basics" });
    expect(quizzes[3]).toMatchObject({ title: "Memory", chapterTitle: "Advanced" });
    // The phantom course-level quizzes must not appear.
    expect(quizzes.some((q) => q.quizId === "q1")).toBe(false);
    // And the ids the client asked for were not honoured.
    expect(lessons).not.toContain("l1");
  });

  // Scores are recorded through the service, never posted from a client: there
  // is no endpoint that accepts a score (see routes/progress.routes.ts).
  //
  // The retake here scores HIGHER and still does not move `bestScore`. That is
  // the anti-cheat rule, not an accident: submitting an exam returns the answer
  // key so the student can review it, so a second attempt is sat already knowing
  // the answers and is recorded as practice.
  it("counts only the first attempt towards the score, but every attempt in the count", async () => {
    const first = await submitQuiz(userId, lessons[0]!, 40, courseId);
    const retake = await submitQuiz(userId, lessons[0]!, 80, courseId);
    expect(first.graded).toBe(true);
    expect(retake.graded).toBe(false);

    const res = await request(app).get(`/api/courses/${courseId}/detail`).set(auth());
    const l1 = res.body.data.quizzes.find((q: { quizId: string }) => q.quizId === lessons[0]);
    expect(l1.bestScore).toBe(40);
    expect(l1.attempts).toBe(2);
    expect(l1.passed).toBe(false);

    // A first attempt that passes does count.
    await submitQuiz(userId, lessons[2]!, 90, courseId);

    // Untaken lessons are listed, not hidden — and are not counted as failures.
    const l2 = res.body.data.quizzes.find((q: { quizId: string }) => q.quizId === lessons[1]);
    expect(l2.bestScore).toBeNull();
    expect(l2.attempts).toBe(0);
    expect(l2.passed).toBe(false);

    const after = await request(app).get(`/api/courses/${courseId}/detail`).set(auth());
    const l3 = after.body.data.quizzes.find((q: { quizId: string }) => q.quizId === lessons[2]);
    expect(l3.bestScore).toBe(90);
    expect(l3.passed).toBe(true);

    // l1 was sat but failed on the graded attempt; l3 passed.
    expect(after.body.data.stats.assessmentsPassed).toBe(1);
    expect(after.body.data.stats.assessmentsTaken).toBe(2);
    expect(after.body.data.stats.assessmentsTotal).toBe(4);
  });

  it("reports path lock: step 1 unlocked, step 2 locked until step 1 completes", async () => {
    const step1 = await request(app).post("/api/courses").set(auth()).send({
      title: "Path Step 1",
      chapters: [{ title: "Ch", modules: [{ title: "M", topics: [{ title: "T1", lessonId: "p1l1" }] }] }],
    });
    const step2 = await request(app).post("/api/courses").set(auth()).send({
      title: "Path Step 2",
      chapters: [{ title: "Ch", modules: [{ title: "M", topics: [{ title: "T1", lessonId: "p2l1" }] }] }],
    });
    const step1Id = step1.body.data._id;
    const step2Id = step2.body.data._id;
    const step1Lesson = step1.body.data.chapters[0].modules[0].topics[0].lessonId;
    const pathId = new mongoose.Types.ObjectId();
    await CourseModel.updateOne(
      { _id: step1Id },
      { $set: { pathId, pathTitle: "Become a Dev", order: 1, pathTotal: 2 } },
    );
    await CourseModel.updateOne(
      { _id: step2Id },
      { $set: { pathId, pathTitle: "Become a Dev", order: 2, pathTotal: 2 } },
    );

    const res1 = await request(app).get(`/api/courses/${step1Id}/detail`).set(auth());
    expect(res1.body.data.path).toMatchObject({ order: 1, total: 2, unlocked: true, previousTitle: null });

    const res2Before = await request(app).get(`/api/courses/${step2Id}/detail`).set(auth());
    expect(res2Before.body.data.path).toMatchObject({
      order: 2,
      total: 2,
      unlocked: false,
      previousTitle: "Path Step 1",
    });

    await request(app).post("/api/progress/enroll").set(auth()).send({ courseId: step1Id });
    await request(app).post("/api/progress/complete-lesson").set(auth()).send({ courseId: step1Id, lessonId: step1Lesson });

    const res2After = await request(app).get(`/api/courses/${step2Id}/detail`).set(auth());
    expect(res2After.body.data.path.unlocked).toBe(true);
  });

  it("404s for another user's course", async () => {
    const other = await request(app).post("/api/auth/register").send({
      name: "Other", username: "otherc", email: "otherc@example.com", password: "supersecret123",
    });
    const res = await request(app).get(`/api/courses/${courseId}/detail`).set({ Authorization: `Bearer ${other.body.data.accessToken}` });
    expect(res.status).toBe(404);
  });
});
