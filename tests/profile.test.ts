import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { submitQuiz } from "../src/services/progress.service.js";

let mongo: MongoMemoryServer;
let token: string;
let userId: string;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const res = await request(app).post("/api/auth/register").send({
    name: "Profile Tester",
    username: "profiletester",
    email: "profile@example.com",
    password: "supersecret123",
  });
  token = res.body.data.accessToken;
  userId = res.body.data.user.id;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe("profile", () => {
  it("returns the profile with locked email/username", async () => {
    const res = await request(app).get("/api/user/profile").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.profile.email).toBe("profile@example.com");
    expect(res.body.data.profile.username).toBe("profiletester");
    expect(res.body.data.profile.role).toBe("Learner");
  });

  it("updates editable fields but ignores email/username changes", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set(auth())
      .send({
        name: "Updated Name",
        phone: "+880 111",
        bio: "Hello world",
        email: "hacker@evil.com",
        username: "hacker",
      });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.name).toBe("Updated Name");
    expect(res.body.data.profile.phone).toBe("+880 111");
    expect(res.body.data.profile.bio).toBe("Hello world");
    // locked fields unchanged
    expect(res.body.data.profile.email).toBe("profile@example.com");
    expect(res.body.data.profile.username).toBe("profiletester");
  });

  it("sets an avatar", async () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const res = await request(app).put("/api/user/avatar").set(auth()).send({ avatar: dataUrl });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.avatar).toBe(dataUrl);
  });

  it("rejects a non-image avatar", async () => {
    const res = await request(app).put("/api/user/avatar").set(auth()).send({ avatar: "not-an-image" });
    expect(res.status).toBe(400);
  });
});

describe("learning background", () => {
  const patch = (body: Record<string, unknown>) =>
    request(app).patch("/api/user/profile").set(auth()).send(body);

  it("returns an all-empty learner block before anything is answered", async () => {
    const res = await request(app).get("/api/user/profile").set(auth());
    expect(res.body.data.profile.learner).toMatchObject({
      occupation: "",
      experienceYears: null,
      learningInterests: [],
    });
  });

  it("saves the learner fields and reads them back", async () => {
    const res = await patch({
      occupation: "job",
      educationLevel: "undergrad",
      roleTitle: "Backend Engineer",
      industry: "Fintech",
      experienceYears: 4,
      learningInterests: ["Cloud & DevOps", "Data & AI"],
      weeklyHours: 6,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.learner).toMatchObject({
      occupation: "job",
      roleTitle: "Backend Engineer",
      experienceYears: 4,
      learningInterests: ["Cloud & DevOps", "Data & AI"],
      weeklyHours: 6,
    });
  });

  it("clears a field when the student blanks it", async () => {
    await patch({ roleTitle: "Backend Engineer" });
    const res = await patch({ roleTitle: "" });
    expect(res.body.data.profile.learner.roleTitle).toBe("");
  });

  it("rejects a value outside the enum", async () => {
    expect((await patch({ occupation: "astronaut" })).status).toBe(400);
  });

  it("rejects an out-of-range number", async () => {
    expect((await patch({ experienceYears: 900 })).status).toBe(400);
  });

  it("locks an edited field against the chat extractor", async () => {
    await patch({ industry: "Fintech" });
    const { upsertLearnerProfile, getLearnerProfile } = await import(
      "../src/services/learnerProfile.service.js"
    );
    const userId = (await request(app).get("/api/user/profile").set(auth())).body.data.profile.id;

    await upsertLearnerProfile(userId, { industry: "Retail" }, "chat");
    expect((await getLearnerProfile(userId))!.industry).toBe("Fintech");
  });

  it("leaves the learner block alone when only account fields are patched", async () => {
    await patch({ occupation: "job" });
    const res = await patch({ name: "Still Me" });
    expect(res.body.data.profile.learner.occupation).toBe("job");
  });
});

describe("progress → stats", () => {
  // Progress is recorded against a real course the caller owns — both ids are
  // validated server-side, so a made-up courseId or lessonId is a 404.
  // Lesson ids are assigned by the server, so they are read back, not chosen.
  let courseId: string;
  let lessons: string[];

  beforeAll(async () => {
    const created = await request(app).post("/api/courses").set(auth()).send({
      title: "Python for AI",
      chapters: [
        {
          title: "Basics",
          modules: [
            {
              title: "Intro",
              topics: [{ title: "One", lessonId: "l1" }, { title: "Two", lessonId: "l2" }],
            },
          ],
        },
      ],
    });
    courseId = created.body.data._id;
    lessons = created.body.data.chapters[0].modules[0].topics.map(
      (t: { lessonId: string }) => t.lessonId,
    );
  });

  it("enrollment reflects in stats and awards first_course", async () => {
    await request(app).post("/api/progress/enroll").set(auth()).send({ courseId });
    const res = await request(app).get("/api/user/stats").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.coursesEnrolled).toBe(1);
    expect(res.body.data.achievements.some((a: { key: string }) => a.key === "first_course")).toBe(true);
  });

  it("rejects progress against a course the caller does not own", async () => {
    const bogus = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .post("/api/progress/complete-lesson")
      .set(auth())
      .send({ courseId: bogus, lessonId: "l1" });
    expect(res.status).toBe(404);
  });

  it("rejects a lessonId that is not part of the course", async () => {
    const res = await request(app)
      .post("/api/progress/complete-lesson")
      .set(auth())
      .send({ courseId, lessonId: "not-a-real-lesson" });
    expect(res.status).toBe(404);
  });

  it("completed lessons and quizzes aggregate", async () => {
    await request(app).post("/api/progress/complete-lesson").set(auth()).send({ courseId, lessonId: lessons[0] });
    await request(app).post("/api/progress/complete-lesson").set(auth()).send({ courseId, lessonId: lessons[1] });
    // duplicate lesson id shouldn't double-count
    await request(app).post("/api/progress/complete-lesson").set(auth()).send({ courseId, lessonId: lessons[1] });

    // Recorded through the service — a score is never accepted from a client.
    // Five different quiz ids, so each is a first (graded) attempt.
    for (let i = 0; i < 5; i++) {
      await submitQuiz(userId, `q${i}`, 95);
    }

    const res = await request(app).get("/api/user/stats").set(auth());
    expect(res.body.data.lessonsCompleted).toBe(2);
    expect(res.body.data.quizAvg).toBe(95);
    // 5 quizzes at 90%+ → quiz_master
    expect(res.body.data.achievements.some((a: { key: string }) => a.key === "quiz_master")).toBe(true);
  });

  it("logs study time", async () => {
    await request(app).post("/api/progress/study-time").set(auth()).send({ seconds: 1800 });
    const res = await request(app).get("/api/user/stats").set(auth());
    expect(res.body.data.studyTimeSeconds).toBe(1800);
    expect(res.body.data.studyByDay).toHaveLength(7);
  });
});

describe("wishlist", () => {
  it("toggles a course on and off", async () => {
    const on = await request(app).put("/api/user/wishlist/deep-learning-fundamentals").set(auth());
    expect(on.status).toBe(200);
    expect(on.body.data.profile.wishlistCourseIds).toEqual(["deep-learning-fundamentals"]);

    const off = await request(app).put("/api/user/wishlist/deep-learning-fundamentals").set(auth());
    expect(off.body.data.profile.wishlistCourseIds).toEqual([]);
  });
});
