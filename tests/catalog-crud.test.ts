import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as courseService from "../src/services/course.service.js";
import * as projectService from "../src/services/project.service.js";

let mongo: MongoMemoryServer;

const owner = new Types.ObjectId().toString();
const stranger = new Types.ObjectId().toString();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("course service crud", () => {
  it("updates an owned course", async () => {
    const c = await courseService.createCourse(owner, { title: "TS Deep Dive", lessons: 5 });
    const updated = await courseService.updateCourse(owner, String(c._id), {
      title: "TS Deeper Dive",
      lessons: 7,
    });
    expect(updated.title).toBe("TS Deeper Dive");
    expect(updated.lessons).toBe(7);
  });

  it("rejects access to another user's course with 404", async () => {
    const c = await courseService.createCourse(owner, { title: "Private Course" });
    await expect(
      courseService.updateCourse(stranger, String(c._id), { title: "x" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(courseService.deleteCourse(stranger, String(c._id))).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("rejects a malformed id with 400", async () => {
    await expect(courseService.getCourse(owner, "nope")).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("deletes an owned course", async () => {
    const c = await courseService.createCourse(owner, { title: "Temp Course" });
    await courseService.deleteCourse(owner, String(c._id));
    await expect(courseService.getCourse(owner, String(c._id))).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("project service crud", () => {
  it("updates an owned project", async () => {
    const p = await projectService.createProject(owner, { title: "Chatbot", tags: ["nlp"] });
    const updated = await projectService.updateProject(owner, String(p._id), {
      title: "Better Chatbot",
      tags: ["nlp", "agents"],
    });
    expect(updated.title).toBe("Better Chatbot");
    expect(updated.tags).toEqual(["nlp", "agents"]);
  });

  it("rejects access to another user's project with 404", async () => {
    const p = await projectService.createProject(owner, { title: "Private Project" });
    await expect(
      projectService.updateProject(stranger, String(p._id), { title: "x" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(projectService.deleteProject(stranger, String(p._id))).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("deletes an owned project", async () => {
    const p = await projectService.createProject(owner, { title: "Temp Project" });
    await projectService.deleteProject(owner, String(p._id));
    await expect(projectService.getProject(owner, String(p._id))).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
