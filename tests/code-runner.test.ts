import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { env } from "../src/config/env.js";

/**
 * The remote half of the classroom's code runner.
 *
 * Python and JavaScript run in the student's browser; this covers the ~30 other
 * languages in the curriculum, through Judge0. What is worth pinning is not the
 * HTTP plumbing but the two judgements the service makes on Judge0's behalf:
 *
 *   - a program that crashes or will not compile is a RESULT, not an API error,
 *     because the tutor teaches from it — a 500 here would surface in a live
 *     class as "something broke" instead of "your code has a bug";
 *   - a compile error's text lives in Judge0's own `compile_output` field, not
 *     on stderr, so a naive reading loses the only message that would have told
 *     the student what was wrong.
 */

let mongo: MongoMemoryServer;
let token: string;
const originalUrl = env.JUDGE0_URL;

const auth = () => ({ Authorization: `Bearer ${token}` });
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** Judge0 answers submissions; /languages is asked once, on first use. */
function mockJudge0(result: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/languages")) {
      return new Response(
        JSON.stringify([
          { id: 60, name: "Go (1.13.5)" },
          { id: 62, name: "Java (OpenJDK 13.0.1)" },
          { id: 50, name: "C (GCC 9.2.0)" },
          { id: 105, name: "C++ (GCC 14.1.0)" },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const reg = await request(app).post("/api/auth/register").send({
    name: "Runner Student",
    username: "runnerstudent",
    email: "runner@example.com",
    password: "supersecret123",
  });
  token = reg.body.data.accessToken;
});

afterEach(() => {
  vi.restoreAllMocks();
  (env as { JUDGE0_URL?: string }).JUDGE0_URL = originalUrl;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("code runner", () => {
  it("reports the browser lane even with no remote runner configured", async () => {
    (env as { JUDGE0_URL?: string }).JUDGE0_URL = undefined;
    const res = await request(app).get("/api/run/languages").set(auth());
    expect(res.status).toBe(200);
    // Python and JS need no server at all, so they are true of every
    // deployment. An empty remote list is a supported state, not an outage.
    expect(res.body.data.browser).toEqual(["python", "javascript"]);
    expect(res.body.data.remote).toEqual([]);
  });

  it("lists the compiled languages once a runner is configured", async () => {
    (env as { JUDGE0_URL?: string }).JUDGE0_URL = "https://judge0.test";
    const res = await request(app).get("/api/run/languages").set(auth());
    expect(res.body.data.remote).toContain("cpp");
    expect(res.body.data.remote).toContain("java");
    expect(res.body.data.remote).toContain("rust");
  });

  it("runs a program and returns stdout", async () => {
    (env as { JUDGE0_URL?: string }).JUDGE0_URL = "https://judge0.test";
    mockJudge0({ stdout: b64("42\n"), status: { id: 3, description: "Accepted" }, time: "0.031" });

    const res = await request(app)
      .post("/api/run")
      .set(auth())
      .send({ language: "go", source: 'package main\nfunc main(){println("42")}' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: true, stdout: "42\n", timedOut: false });
  });

  it("returns a compile error as a RESULT, not an API failure", async () => {
    (env as { JUDGE0_URL?: string }).JUDGE0_URL = "https://judge0.test";
    mockJudge0({
      compile_output: b64("main.cpp:2:5: error: 'cout' was not declared in this scope"),
      status: { id: 6, description: "Compilation Error" },
    });

    const res = await request(app)
      .post("/api/run")
      .set(auth())
      .send({ language: "cpp", source: "int main(){cout<<1;}" });

    // 200, because a broken program is the thing the tutor is about to teach
    // from. A 500 would reach the classroom as "something broke".
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(false);
    // And the message survives: Judge0 puts it in compile_output, so reading
    // only stderr would have thrown away the one line that explains the bug.
    expect(res.body.data.stderr).toContain("'cout' was not declared");
  });

  it("uses the id THIS instance reports, not the built-in one", async () => {
    // The reason /languages is consulted at all. Judge0's ids drift between
    // versions, and a drifted id does not error — it compiles the student's C++
    // as whatever now sits at 54. Here the instance says C++ is 105, so 105 is
    // what must be submitted.
    (env as { JUDGE0_URL?: string }).JUDGE0_URL = "https://judge0.test";
    const sent: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/languages")) {
        return new Response(JSON.stringify([{ id: 105, name: "C++ (GCC 14.1.0)" }]), {
          status: 200,
        });
      }
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ stdout: b64("ok\n"), status: { id: 3 } }), {
        status: 200,
      });
    });

    await request(app)
      .post("/api/run")
      .set(auth())
      .send({ language: "cpp", source: "int main(){}" });

    expect((sent[0] as { language_id: number }).language_id).toBe(105);
  });

  it("does not run C as C++", async () => {
    // "C++ (GCC …)" also starts with the letter C, and it is listed after the
    // C build — a loose name match sent every C program to the C++ compiler.
    (env as { JUDGE0_URL?: string }).JUDGE0_URL = "https://judge0.test";
    const sent: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/languages")) {
        return new Response(
          JSON.stringify([
            { id: 50, name: "C (GCC 9.2.0)" },
            { id: 105, name: "C++ (GCC 14.1.0)" },
          ]),
          { status: 200 },
        );
      }
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ stdout: b64("ok\n"), status: { id: 3 } }), {
        status: 200,
      });
    });

    await request(app)
      .post("/api/run")
      .set(auth())
      .send({ language: "c", source: "int main(){return 0;}" });

    expect((sent[0] as { language_id: number }).language_id).toBe(50);
  });

  it("marks a timeout as timed out rather than merely failed", async () => {
    (env as { JUDGE0_URL?: string }).JUDGE0_URL = "https://judge0.test";
    mockJudge0({ status: { id: 5, description: "Time Limit Exceeded" } });

    const res = await request(app)
      .post("/api/run")
      .set(auth())
      .send({ language: "java", source: "class Main{public static void main(String[] a){while(true){}}}" });

    expect(res.body.data.timedOut).toBe(true);
    expect(res.body.data.ok).toBe(false);
  });

  it("refuses a language it has no runner for", async () => {
    (env as { JUDGE0_URL?: string }).JUDGE0_URL = "https://judge0.test";
    const res = await request(app)
      .post("/api/run")
      .set(auth())
      .send({ language: "brainfuck", source: "+++" });
    expect(res.status).toBe(400);
  });

  it("answers 503 when no runner is configured, rather than hanging", async () => {
    (env as { JUDGE0_URL?: string }).JUDGE0_URL = undefined;
    const res = await request(app)
      .post("/api/run")
      .set(auth())
      .send({ language: "go", source: "package main" });
    expect(res.status).toBe(503);
  });

  it("requires authentication", async () => {
    const res = await request(app).post("/api/run").send({ language: "go", source: "x" });
    expect(res.status).toBe(401);
  });
});
