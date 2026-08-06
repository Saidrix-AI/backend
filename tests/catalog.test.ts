import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";

let mongo: MongoMemoryServer;
let token: string;
let otherToken: string;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const res = await request(app).post("/api/auth/register").send({
    name: "Catalog Owner",
    username: "catalogowner",
    email: "catalogowner@example.com",
    password: "supersecret123",
  });
  token = res.body.data.accessToken;

  const other = await request(app).post("/api/auth/register").send({
    name: "Other User",
    username: "otheruser",
    email: "otheruser@example.com",
    password: "supersecret123",
  });
  otherToken = other.body.data.accessToken;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("courses catalog", () => {
  it("creates a course and lists only the owner's courses", async () => {
    const created = await request(app)
      .post("/api/courses")
      .set(auth(token))
      .send({ title: "Intro to Agents", desc: "Basics", level: "Beginner", lessons: 8, icon: "robot" });
    expect(created.status).toBe(201);
    expect(created.body.data.title).toBe("Intro to Agents");
    expect(created.body.data._id).toBeTruthy();

    const mine = await request(app).get("/api/courses").set(auth(token));
    expect(mine.status).toBe(200);
    expect(mine.body.data).toHaveLength(1);

    // A different user sees none of the first user's courses.
    const theirs = await request(app).get("/api/courses").set(auth(otherToken));
    expect(theirs.body.data).toHaveLength(0);
  });

  it("rejects a course with no title", async () => {
    const res = await request(app).post("/api/courses").set(auth(token)).send({ desc: "no title" });
    expect(res.status).toBe(400);
  });

  it("deletes an owned course over HTTP, guarding ownership and bad ids", async () => {
    const created = await request(app)
      .post("/api/courses")
      .set(auth(token))
      .send({ title: "Doomed Course", lessons: 3 });
    const id = created.body.data._id as string;

    // Another user cannot delete it.
    const foreign = await request(app).delete(`/api/courses/${id}`).set(auth(otherToken));
    expect(foreign.status).toBe(404);

    // Malformed id.
    const bad = await request(app).delete("/api/courses/not-an-id").set(auth(token));
    expect(bad.status).toBe(400);

    // Owner deletes it; a second delete then 404s.
    const ok = await request(app).delete(`/api/courses/${id}`).set(auth(token));
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
    const again = await request(app).delete(`/api/courses/${id}`).set(auth(token));
    expect(again.status).toBe(404);
  });
});

describe("projects catalog", () => {
  it("creates a project and lists only the owner's projects", async () => {
    const created = await request(app)
      .post("/api/projects")
      .set(auth(token))
      .send({ title: "Chatbot", desc: "Build one", tags: ["Python", "NLP"], featured: true });
    expect(created.status).toBe(201);
    expect(created.body.data.tags).toEqual(["Python", "NLP"]);

    const mine = await request(app).get("/api/projects").set(auth(token));
    expect(mine.body.data).toHaveLength(1);

    const theirs = await request(app).get("/api/projects").set(auth(otherToken));
    expect(theirs.body.data).toHaveLength(0);
  });

  it("rejects a project with no title", async () => {
    const res = await request(app).post("/api/projects").set(auth(token)).send({ desc: "x" });
    expect(res.status).toBe(400);
  });

  it("edits an owned project over HTTP, guarding ownership", async () => {
    const created = await request(app)
      .post("/api/projects")
      .set(auth(token))
      .send({ title: "Editable", tags: ["a"] });
    const id = created.body.data._id as string;

    const patched = await request(app)
      .patch(`/api/projects/${id}`)
      .set(auth(token))
      .send({ title: "Edited Title", tags: ["a", "b"] });
    expect(patched.status).toBe(200);
    expect(patched.body.data.title).toBe("Edited Title");
    expect(patched.body.data.tags).toEqual(["a", "b"]);

    // An empty patch is rejected.
    const empty = await request(app).patch(`/api/projects/${id}`).set(auth(token)).send({});
    expect(empty.status).toBe(400);

    // Another user cannot edit it.
    const foreign = await request(app)
      .patch(`/api/projects/${id}`)
      .set(auth(otherToken))
      .send({ title: "hijacked" });
    expect(foreign.status).toBe(404);
  });

  it("deletes an owned project over HTTP, guarding ownership and bad ids", async () => {
    const created = await request(app)
      .post("/api/projects")
      .set(auth(token))
      .send({ title: "Doomed Project" });
    const id = created.body.data._id as string;

    const foreign = await request(app).delete(`/api/projects/${id}`).set(auth(otherToken));
    expect(foreign.status).toBe(404);

    const bad = await request(app).delete("/api/projects/not-an-id").set(auth(token));
    expect(bad.status).toBe(400);

    const ok = await request(app).delete(`/api/projects/${id}`).set(auth(token));
    expect(ok.status).toBe(200);
    const again = await request(app).delete(`/api/projects/${id}`).set(auth(token));
    expect(again.status).toBe(404);
  });

  it("archives and unarchives a project via the progress API", async () => {
    const created = await request(app)
      .post("/api/projects")
      .set(auth(token))
      .send({ title: "Archivable" });
    const id = created.body.data._id as string;

    const arch = await request(app).post(`/api/progress/project/${id}/archive`).set(auth(token));
    expect(arch.status).toBe(200);
    let mine = await request(app).get("/api/progress/projects").set(auth(token));
    expect(mine.body.data.find((r: { projectId: string }) => r.projectId === id)?.status).toBe(
      "archived",
    );

    const unarch = await request(app)
      .post(`/api/progress/project/${id}/unarchive`)
      .set(auth(token));
    expect(unarch.status).toBe(200);
    expect(unarch.body.data.status).toBe("in_progress");
    mine = await request(app).get("/api/progress/projects").set(auth(token));
    expect(mine.body.data.find((r: { projectId: string }) => r.projectId === id)?.status).toBe(
      "in_progress",
    );
  });

  it("restores an archived-but-previously-submitted project to completed, not in_progress", async () => {
    const created = await request(app)
      .post("/api/projects")
      .set(auth(token))
      .send({ title: "Submitted Then Archived" });
    const id = created.body.data._id as string;

    // Submitting marks it completed (MVP rule: submitting IS completing).
    const submitted = await request(app)
      .post(`/api/progress/project/${id}/submit`)
      .set(auth(token))
      .send({ method: "github", value: "https://github.com/x/y" });
    expect(submitted.status).toBe(200);

    const arch = await request(app).post(`/api/progress/project/${id}/archive`).set(auth(token));
    expect(arch.status).toBe(200);
    let mine = await request(app).get("/api/progress/projects").set(auth(token));
    expect(mine.body.data.find((r: { projectId: string }) => r.projectId === id)?.status).toBe(
      "archived",
    );

    const unarch = await request(app)
      .post(`/api/progress/project/${id}/unarchive`)
      .set(auth(token));
    expect(unarch.status).toBe(200);
    expect(unarch.body.data.status).toBe("completed");
    mine = await request(app).get("/api/progress/projects").set(auth(token));
    expect(mine.body.data.find((r: { projectId: string }) => r.projectId === id)?.status).toBe(
      "completed",
    );
  });

  it("requires auth", async () => {
    const res = await request(app).get("/api/courses");
    expect(res.status).toBe(401);
  });
});
