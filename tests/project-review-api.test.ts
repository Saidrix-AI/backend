import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const makeProjectRequirements = vi.hoisted(() => vi.fn());
const ingestSubmission = vi.hoisted(() => vi.fn());
const reviewProject = vi.hoisted(() => vi.fn());

// The agents are exercised in project-reviewer.test.ts / project-requirements.test.ts;
// here we only care that the API wires them up, scopes them and records their outcome.
vi.mock("../src/agents/project-requirements/index.js", () => ({ makeProjectRequirements }));
vi.mock("../src/agents/project-reviewer/index.js", () => ({ ingestSubmission, reviewProject }));

const { app } = await import("../src/app.js");
const { ApiError } = await import("../src/utils/apiError.js");

let mongo: MongoMemoryServer;
let token: string;
let otherToken: string;

const REQUIREMENTS = {
  goal: "Build a CLI guessing game.",
  requirements: ["Must define a main() function", "Must handle non-numeric input"],
};

const RESULT = {
  qualityScore: 68,
  requirementResults: [
    { requirement: "Must define a main() function", met: true, evidence: "main.py:3" },
    { requirement: "Must handle non-numeric input", met: false, evidence: "missing" },
  ],
  fileTree: [{ name: "main.py", type: "file", badge: 1 }],
  files: [
    {
      path: "main.py",
      language: "python",
      content: "def main():\n    pass\n",
      errors: 1,
      warnings: 0,
      suggestions: 0,
      issues: [{ line: 2, severity: "error", text: "main() does nothing", why: "", fix: "", learn: "" }],
    },
  ],
  overallFeedback: "Good start.",
  truncated: false,
};

async function registerUser(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/register").send({
    name: username,
    username,
    email: `${username}@example.com`,
    password: "supersecret123",
  });
  return res.body.data.accessToken;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  token = await registerUser("reviewtester");
  otherToken = await registerUser("otherreviewtester");
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(() => {
  vi.clearAllMocks();
  makeProjectRequirements.mockResolvedValue(REQUIREMENTS);
  ingestSubmission.mockResolvedValue({ files: [], paths: ["main.py"], truncated: false, rootName: "p" });
  reviewProject.mockResolvedValue(RESULT);
});

const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

async function createProject(title = "Number Guessing Game"): Promise<string> {
  const res = await request(app).post("/api/projects").set(auth()).send({ title, tags: ["python"] });
  return res.body.data._id;
}

/** The review job is detached from the request; poll it the way the UI does. */
async function pollUntilSettled(reviewId: string, t = token) {
  for (let i = 0; i < 40; i++) {
    const res = await request(app).get(`/api/projects/reviews/${reviewId}`).set(auth(t));
    if (res.body.data?.status !== "running") return res;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("review never settled");
}

describe("project creation authors requirements", () => {
  it("stores the AI-authored goal and checklist", async () => {
    const id = await createProject();
    const res = await request(app).get(`/api/projects/${id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.goal).toBe(REQUIREMENTS.goal);
    expect(res.body.data.requirements).toEqual(REQUIREMENTS.requirements);
    expect(makeProjectRequirements).toHaveBeenCalledTimes(1);
  });

  it("still creates the project when authoring fails", async () => {
    makeProjectRequirements.mockRejectedValueOnce(new Error("llm down"));
    const res = await request(app).post("/api/projects").set(auth()).send({ title: "Fallback Project" });
    expect(res.status).toBe(201);
    expect(res.body.data.requirements).toEqual([]);
  });

  it("backfills an empty checklist on first detail read, once", async () => {
    makeProjectRequirements.mockRejectedValueOnce(new Error("llm down"));
    const created = await request(app).post("/api/projects").set(auth()).send({ title: "Backfill Me" });
    const id = created.body.data._id;

    const first = await request(app).get(`/api/projects/${id}`).set(auth());
    expect(first.body.data.requirements).toEqual(REQUIREMENTS.requirements);

    const second = await request(app).get(`/api/projects/${id}`).set(auth());
    expect(second.body.data.requirements).toEqual(REQUIREMENTS.requirements);
    // Once for the failed create, once for the backfill — the second read is free.
    expect(makeProjectRequirements).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/projects/:id/review", () => {
  it("accepts a GitHub link, returns 202, and completes the review", async () => {
    const id = await createProject();
    const res = await request(app)
      .post(`/api/projects/${id}/review`)
      .set(auth())
      .send({ value: "https://github.com/octocat/hello-world" });

    expect(res.status).toBe(202);
    expect(res.body.data.attempt).toBe(1);

    const settled = await pollUntilSettled(res.body.data.reviewId);
    expect(settled.body.data.status).toBe("completed");
    expect(settled.body.data.qualityScore).toBe(68);
    expect(settled.body.data.files[0].issues[0].line).toBe(2);
    expect(settled.body.data.overallFeedback).toBe("Good start.");
    expect(ingestSubmission).toHaveBeenCalledWith("github", "https://github.com/octocat/hello-world", undefined);
  });

  it("passes the project's goal and requirements to the reviewer", async () => {
    const id = await createProject();
    const res = await request(app).post(`/api/projects/${id}/review`).set(auth()).send({ value: "https://github.com/a/b" });
    await pollUntilSettled(res.body.data.reviewId);

    expect(reviewProject.mock.calls[0]![0]).toMatchObject({
      title: "Number Guessing Game",
      goal: REQUIREMENTS.goal,
      requirements: REQUIREMENTS.requirements,
    });
  });

  it("accepts an uploaded zip", async () => {
    const id = await createProject();
    const res = await request(app)
      .post(`/api/projects/${id}/review`)
      .set(auth())
      .attach("zip", Buffer.from("PK-fake-zip"), "my-project.zip");

    expect(res.status).toBe(202);
    const settled = await pollUntilSettled(res.body.data.reviewId);
    expect(settled.body.data.method).toBe("file");
    expect(settled.body.data.sourceRef).toBe("my-project.zip");
    expect(ingestSubmission.mock.calls[0]![0]).toBe("file");
    expect(ingestSubmission.mock.calls[0]![2]).toBeInstanceOf(Buffer);
  });

  it("rejects a request with neither a link nor a file", async () => {
    const id = await createProject();
    const res = await request(app).post(`/api/projects/${id}/review`).set(auth()).send({});
    expect(res.status).toBe(400);
  });

  it("404s on another user's project", async () => {
    const id = await createProject();
    const res = await request(app).post(`/api/projects/${id}/review`).set(auth(otherToken)).send({ value: "x" });
    expect(res.status).toBe(404);
  });

  it("numbers attempts from the submission history", async () => {
    const id = await createProject();
    const first = await request(app).post(`/api/projects/${id}/review`).set(auth()).send({ value: "https://github.com/a/b" });
    await pollUntilSettled(first.body.data.reviewId);
    const second = await request(app).post(`/api/projects/${id}/review`).set(auth()).send({ value: "https://github.com/a/c" });
    expect(second.body.data.attempt).toBe(2);
    await pollUntilSettled(second.body.data.reviewId);

    const list = await request(app).get(`/api/projects/${id}/reviews`).set(auth());
    expect(list.body.data.map((r: { attempt: number }) => r.attempt)).toEqual([2, 1]);
    // The list is for a status table — file bodies would make it enormous.
    expect(list.body.data[0].files).toBeUndefined();
  });
});

describe("review failure", () => {
  it("records the ingest error on the review instead of hanging", async () => {
    ingestSubmission.mockRejectedValueOnce(new ApiError(400, "We couldn't reach github.com/a/b."));
    const id = await createProject();
    const res = await request(app).post(`/api/projects/${id}/review`).set(auth()).send({ value: "https://github.com/a/b" });
    expect(res.status).toBe(202);

    const settled = await pollUntilSettled(res.body.data.reviewId);
    expect(settled.body.data.status).toBe("failed");
    expect(settled.body.data.errorMessage).toContain("couldn't reach");
  });

  it("hides an unexpected pipeline error behind a generic message", async () => {
    reviewProject.mockRejectedValueOnce(new Error("OPENAI_API_KEY=sk-secret is invalid"));
    const id = await createProject();
    const res = await request(app).post(`/api/projects/${id}/review`).set(auth()).send({ value: "https://github.com/a/b" });

    const settled = await pollUntilSettled(res.body.data.reviewId);
    expect(settled.body.data.status).toBe("failed");
    expect(settled.body.data.errorMessage).toBe("Something went wrong while reviewing this submission.");
    expect(settled.body.data.errorMessage).not.toContain("sk-secret");
  });
});

describe("GET review", () => {
  it("404s another user's review", async () => {
    const id = await createProject();
    const res = await request(app).post(`/api/projects/${id}/review`).set(auth()).send({ value: "https://github.com/a/b" });
    await pollUntilSettled(res.body.data.reviewId);

    const stolen = await request(app).get(`/api/projects/reviews/${res.body.data.reviewId}`).set(auth(otherToken));
    expect(stolen.status).toBe(404);
  });

  it("400s a malformed review id rather than 500ing", async () => {
    const res = await request(app).get("/api/projects/reviews/not-an-id").set(auth());
    expect(res.status).toBe(400);
  });

  it("serves a review by attempt number for deep links", async () => {
    const id = await createProject();
    const res = await request(app).post(`/api/projects/${id}/review`).set(auth()).send({ value: "https://github.com/a/b" });
    await pollUntilSettled(res.body.data.reviewId);

    const byAttempt = await request(app).get(`/api/projects/${id}/reviews/1`).set(auth());
    expect(byAttempt.status).toBe(200);
    expect(byAttempt.body.data.qualityScore).toBe(68);
  });
});
