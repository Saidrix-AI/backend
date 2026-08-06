import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PlanId } from "../src/config/plans.js";
import { CourseModel } from "../src/database/models/course.model.js";
import { EnrollmentModel } from "../src/database/models/enrollment.model.js";
import { LearningPathModel } from "../src/database/models/learningPath.model.js";
import { UserModel } from "../src/database/models/user.model.js";
import {
  clearActiveCommitment,
  COOLDOWN_DAYS,
  courseEnterVerdict,
  getActiveState,
  setActiveCourse,
  setActivePath,
} from "../src/services/activeSelection.service.js";
import { listPathsWithCourses } from "../src/services/learningPath.service.js";
import { projectLocks } from "../src/services/projectGate.js";

/**
 * Path-first commitment with a two-sided, PER-PATH lock, and a per-plan cap on
 * how many may run at once. Run against a real in-memory Mongo rather than
 * mocks: the rules are expressed as queries across users, paths, courses and
 * enrollments, so mocking would only test the mocks.
 *
 * The test user has no plan, which entitlementsFor() reads as Basic — one path
 * and one standalone course. `setPlan()` below is what exercises the higher
 * tiers; nothing in the app writes `plan` outside a verified webhook.
 */

let mongo: MongoMemoryServer;
let userId: string;

const LESSONS = 3;
const DAY = 24 * 60 * 60 * 1000;

async function makeCourse(title: string, pathId?: Types.ObjectId, order?: number) {
  const topics = Array.from({ length: LESSONS }, (_, i) => ({
    title: `T${i + 1}`,
    lessonId: `${title}-l${i + 1}`.replace(/\s+/g, "-").toLowerCase(),
  }));
  // `pathTitle` is denormalised onto the course and is what the "activate the X
  // path" message quotes, so it has to carry the real goal — a fixed stand-in
  // would let a test claiming to check that message pass against any path.
  const pathTitle = pathId
    ? ((await LearningPathModel.findById(pathId).select("goal").lean())?.goal ?? "")
    : "";
  const course = await CourseModel.create({
    userId: new Types.ObjectId(userId),
    title,
    lessons: LESSONS,
    chapters: [{ title: "C1", modules: [{ title: "M1", topics }] }],
    ...(pathId ? { pathId, pathTitle, order, pathTotal: 3 } : {}),
  });
  return String(course._id);
}

async function makePath(goal: string) {
  const path = await LearningPathModel.create({
    userId: new Types.ObjectId(userId),
    goal,
    courses: [],
  });
  return path._id as Types.ObjectId;
}

async function setPlan(plan: PlanId) {
  await UserModel.updateOne({ _id: userId }, { $set: { plan, planStatus: "active" } });
}

async function completeCourse(courseId: string) {
  const course = await CourseModel.findById(courseId).lean();
  const lessonIds = (course!.chapters ?? []).flatMap((ch) =>
    (ch.modules ?? []).flatMap((m) => (m.topics ?? []).map((t) => t.lessonId)),
  );
  await EnrollmentModel.updateOne(
    { userId: new Types.ObjectId(userId), courseId },
    { $set: { completedLessonIds: lessonIds } },
    { upsert: true },
  );
}

/** Winds a path's own lock into the past, as if its 3 days had elapsed. */
async function expireLock(pathId: Types.ObjectId) {
  await LearningPathModel.updateOne(
    { _id: pathId },
    { $set: { lockedUntil: new Date(Date.now() - 1000) } },
  );
}

/** The commitment for one path, out of however many are running. */
function forPath(state: Awaited<ReturnType<typeof getActiveState>>, pathId: Types.ObjectId) {
  return state.commitments.find((c) => c.pathId === String(pathId));
}

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
    UserModel.deleteMany({}),
    EnrollmentModel.deleteMany({}),
    LearningPathModel.deleteMany({}),
  ]);
  const user = await UserModel.create({
    name: "Path Tester",
    username: `path-${Date.now()}`,
    email: `path-${Date.now()}@example.com`,
    passwordHash: "x",
  });
  userId = String(user._id);
});

describe("the A → B switching flow (one slot)", () => {
  /**
   * The worked example from the spec, on a Basic plan's single path slot:
   *   t=0   both inactive           -> may activate either
   *   t=0   activate A              -> A locked (active) 3d, cannot deactivate
   *   t=3d  deactivate A            -> A locked (inactive) 3d, cannot reactivate
   *   t=3d  activate B immediately  -> allowed, B locked (active) 3d
   */
  it("runs end to end", async () => {
    const pathA = await makePath("Path A");
    await makeCourse("A step 1", pathA, 1);
    const pathB = await makePath("Path B");
    await makeCourse("B step 1", pathB, 1);

    // t=0 — both free.
    const before = await listPathsWithCourses(userId);
    expect(before.every((p) => p.canActivate)).toBe(true);

    // Activate A → locked as active.
    const a = await setActivePath(userId, String(pathA));
    expect(a.primary!.pathId).toBe(String(pathA));
    expect(a.primary!.canDeactivate).toBe(false);
    expect(a.canActivatePath).toBe(false); // Basic: the one slot is now taken
    const expected = Date.now() + COOLDOWN_DAYS * DAY;
    expect(a.primary!.lockedUntil!.getTime()).toBeGreaterThan(expected - 10_000);
    expect(a.primary!.lockedUntil!.getTime()).toBeLessThan(expected + 10_000);

    // Cannot switch off, and cannot jump straight to B.
    await expect(clearActiveCommitment(userId)).rejects.toMatchObject({ statusCode: 409 });
    await expect(setActivePath(userId, String(pathB))).rejects.toMatchObject({ statusCode: 409 });

    // t=3d — A's active lock has elapsed.
    await expireLock(pathA);
    const cleared = await clearActiveCommitment(userId);
    expect(cleared.commitments).toHaveLength(0);
    expect(cleared.primary).toBeNull();

    // A is now locked the OTHER way: it cannot come back for 3 days...
    await expect(setActivePath(userId, String(pathA))).rejects.toMatchObject({ statusCode: 409 });
    // ...but B was never locked, so it is available immediately.
    const b = await setActivePath(userId, String(pathB));
    expect(b.primary!.pathId).toBe(String(pathB));
    expect(b.primary!.canDeactivate).toBe(false);
  });

  it("reports why each path's Activate button is off", async () => {
    const pathA = await makePath("Path A");
    await makeCourse("A step 1", pathA, 1);
    const pathB = await makePath("Path B");
    await makeCourse("B step 1", pathB, 1);

    await setActivePath(userId, String(pathA));
    const listed = await listPathsWithCourses(userId);

    const a = listed.find((p) => p.pathId === String(pathA))!;
    const b = listed.find((p) => p.pathId === String(pathB))!;
    expect(a.active).toBe(true);
    expect(b.canActivate).toBe(false);
    expect(b.blockedReason).toContain("Path A");
    expect(b.blockedReason).toContain("deactivate it first");

    // After switching A off, B's reason changes to "nothing in the way".
    await expireLock(pathA);
    await clearActiveCommitment(userId);
    const after = await listPathsWithCourses(userId);
    expect(after.find((p) => p.pathId === String(pathB))!.canActivate).toBe(true);
    expect(after.find((p) => p.pathId === String(pathA))!.blockedReason).toContain(
      "Recently deactivated",
    );
  });
});

describe("how many may run at once", () => {
  it("gives Basic one path, Pro two and Premium three", async () => {
    const paths = [await makePath("P1"), await makePath("P2"), await makePath("P3")];
    for (const [i, p] of paths.entries()) await makeCourse(`P${i + 1} step 1`, p, 1);

    // Basic: one, and the second is refused.
    let state = await setActivePath(userId, String(paths[0]));
    expect(state.limits.paths).toBe(1);
    await expect(setActivePath(userId, String(paths[1]))).rejects.toMatchObject({
      statusCode: 409,
    });

    // Pro: the second now fits, the third does not.
    await setPlan("pro");
    state = await setActivePath(userId, String(paths[1]));
    expect(state.limits.paths).toBe(2);
    expect(state.counts.paths).toBe(2);
    expect(state.canActivatePath).toBe(false);
    await expect(setActivePath(userId, String(paths[2]))).rejects.toMatchObject({
      statusCode: 409,
    });

    // Premium: all three.
    await setPlan("premium");
    state = await setActivePath(userId, String(paths[2]));
    expect(state.counts.paths).toBe(3);
    expect(state.canActivatePath).toBe(false);
  });

  it("names the running paths when the cap is hit", async () => {
    await setPlan("pro");
    const p1 = await makePath("Become a data analyst");
    const p2 = await makePath("Learn Rust");
    const p3 = await makePath("Ship an iOS app");
    for (const [i, p] of [p1, p2, p3].entries()) await makeCourse(`step ${i}`, p, 1);

    await setActivePath(userId, String(p1));
    await setActivePath(userId, String(p2));

    await expect(setActivePath(userId, String(p3))).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Become a data analyst"),
    });
    await expect(setActivePath(userId, String(p3))).rejects.toMatchObject({
      message: expect.stringContaining("Learn Rust"),
    });
  });

  it("re-activating an already-active path is a no-op, not a 409", async () => {
    const pathId = await makePath("Path A");
    await makeCourse("step 1", pathId, 1);
    await setActivePath(userId, String(pathId));
    const again = await setActivePath(userId, String(pathId));
    expect(again.counts.paths).toBe(1);
  });

  /**
   * The downgrade rule. Dropping a tier must never switch anything off — the
   * cap is checked on activate and nowhere else, so three running paths keep
   * running on Basic and only the next one is refused.
   */
  it("grandfathers a downgrade: everything keeps running, nothing new starts", async () => {
    await setPlan("premium");
    const paths = [await makePath("P1"), await makePath("P2"), await makePath("P3")];
    const first: string[] = [];
    for (const [i, p] of paths.entries()) first.push(await makeCourse(`P${i + 1} step 1`, p, 1));
    for (const p of paths) await setActivePath(userId, String(p));

    const p4 = await makePath("P4");
    await makeCourse("P4 step 1", p4, 1);

    await setPlan("basic");

    const state = await getActiveState(userId);
    expect(state.counts.paths).toBe(3); // still three, on a one-path plan
    expect(state.limits.paths).toBe(1);
    expect(state.canActivatePath).toBe(false);
    // And every one of them is still open to study.
    for (const courseId of first) {
      await expect(courseEnterVerdict(userId, courseId)).resolves.toMatchObject({
        enterable: true,
      });
    }
    // Only starting a fourth is refused.
    await expect(setActivePath(userId, String(p4))).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("paths and standalone courses are independent slots", () => {
  it("runs a path and a path-less course at the same time", async () => {
    const pathId = await makePath("Path A");
    const inPath = await makeCourse("A step 1", pathId, 1);
    const solo = await makeCourse("Standalone");

    await setActivePath(userId, String(pathId));
    const state = await setActiveCourse(userId, solo);

    expect(state.counts).toEqual({ paths: 1, courses: 1 });
    // Activating the course did not evict the path, which is what the old
    // single-pointer model did.
    expect(forPath(state, pathId)).toBeDefined();
    await expect(courseEnterVerdict(userId, inPath)).resolves.toMatchObject({ enterable: true });
    await expect(courseEnterVerdict(userId, solo)).resolves.toMatchObject({ enterable: true });
  });

  it("still allows only one standalone course, on every tier", async () => {
    await setPlan("premium");
    const solo = await makeCourse("Standalone");
    const other = await makeCourse("Other standalone");

    const state = await setActiveCourse(userId, solo);
    expect(state.limits.courses).toBe(1);
    await expect(setActiveCourse(userId, other)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("deactivating a course leaves the paths alone", async () => {
    const pathId = await makePath("Path A");
    await makeCourse("A step 1", pathId, 1);
    const solo = await makeCourse("Standalone");

    await setActivePath(userId, String(pathId));
    await setActiveCourse(userId, solo);
    await CourseModel.updateOne({ _id: solo }, { $set: { lockedUntil: new Date(Date.now() - 1) } });

    const state = await clearActiveCommitment(userId, { courseId: solo });
    expect(state.counts).toEqual({ paths: 1, courses: 0 });
    expect(forPath(state, pathId)).toBeDefined();
  });
});

describe("deactivating names its target", () => {
  it("switches off the path asked for, not the newest one", async () => {
    await setPlan("pro");
    const p1 = await makePath("First");
    const p2 = await makePath("Second");
    await makeCourse("first step", p1, 1);
    await makeCourse("second step", p2, 1);

    await setActivePath(userId, String(p1));
    await setActivePath(userId, String(p2));
    await expireLock(p1);

    const state = await clearActiveCommitment(userId, { pathId: String(p1) });
    expect(forPath(state, p1)).toBeUndefined();
    expect(forPath(state, p2)).toBeDefined();
  });

  it("with no target, switches off the most recently activated", async () => {
    await setPlan("pro");
    const p1 = await makePath("First");
    const p2 = await makePath("Second");
    await makeCourse("first step", p1, 1);
    await makeCourse("second step", p2, 1);

    await setActivePath(userId, String(p1));
    await setActivePath(userId, String(p2));
    // Make the ordering unambiguous — both were activated in the same instant.
    await LearningPathModel.updateOne(
      { _id: p1 },
      { $set: { activatedAt: new Date(Date.now() - 60_000), lockedUntil: new Date(Date.now() - 1) } },
    );
    await LearningPathModel.updateOne({ _id: p2 }, { $set: { lockedUntil: new Date(Date.now() - 1) } });

    const state = await clearActiveCommitment(userId);
    expect(forPath(state, p2)).toBeUndefined();
    expect(forPath(state, p1)).toBeDefined();
  });

  it("naming a path that is not active is a no-op, not an error", async () => {
    const pathId = await makePath("Never activated");
    await makeCourse("step 1", pathId, 1);
    const state = await clearActiveCommitment(userId, { pathId: String(pathId) });
    expect(state.commitments).toHaveLength(0);
  });
});

describe("sequential unlock inside an active path", () => {
  it("opens step 1 only, then advances as each is finished — never touching the lock", async () => {
    const pathId = await makePath("Full Stack");
    const s1 = await makeCourse("Step 1", pathId, 1);
    const s2 = await makeCourse("Step 2", pathId, 2);
    const s3 = await makeCourse("Step 3", pathId, 3);

    const state = await setActivePath(userId, String(pathId));
    const c = state.primary!;
    expect(c.currentCourseId).toBe(s1);
    expect(c.steps.map((s) => s.status)).toEqual(["current", "locked", "locked"]);
    expect((await courseEnterVerdict(userId, s2)).enterable).toBe(false);

    const lockBefore = c.lockedUntil!.getTime();
    await completeCourse(s1);

    // Progressing is a derived pointer move: no write, so the path's own lock
    // is untouched and no action was required from the student.
    const after = (await getActiveState(userId)).primary!;
    expect(after.currentCourseId).toBe(s2);
    expect(after.steps.map((s) => s.status)).toEqual(["done", "current", "locked"]);
    expect(after.lockedUntil!.getTime()).toBe(lockBefore);

    await expect(courseEnterVerdict(userId, s2)).resolves.toMatchObject({ enterable: true });
    expect((await courseEnterVerdict(userId, s3)).enterable).toBe(false);
    // A finished step stays readable for review.
    await expect(courseEnterVerdict(userId, s1)).resolves.toMatchObject({ enterable: true });
  });
});

describe("what is locked", () => {
  it("locks the courses of every path that is not active", async () => {
    const pathA = await makePath("Path A");
    const a1 = await makeCourse("A step 1", pathA, 1);
    const pathB = await makePath("Path B");
    const b1 = await makeCourse("B step 1", pathB, 1);

    await setActivePath(userId, String(pathA));

    await expect(courseEnterVerdict(userId, a1)).resolves.toMatchObject({ enterable: true });
    const b = await courseEnterVerdict(userId, b1);
    expect(b.enterable).toBe(false);
    expect(b.activatePathId).toBe(String(pathB));
  });

  it("opens both paths' first steps once two are active", async () => {
    await setPlan("pro");
    const pathA = await makePath("Path A");
    const a1 = await makeCourse("A step 1", pathA, 1);
    const pathB = await makePath("Path B");
    const b1 = await makeCourse("B step 1", pathB, 1);

    await setActivePath(userId, String(pathA));
    await setActivePath(userId, String(pathB));

    await expect(courseEnterVerdict(userId, a1)).resolves.toMatchObject({ enterable: true });
    await expect(courseEnterVerdict(userId, b1)).resolves.toMatchObject({ enterable: true });
  });

  it("locks a deactivated path's courses — an inactive path means shut courses", async () => {
    const pathId = await makePath("Full Stack");
    const s1 = await makeCourse("Step 1", pathId, 1);
    const s2 = await makeCourse("Step 2", pathId, 2);

    await setActivePath(userId, String(pathId));
    await completeCourse(s1);
    await expireLock(pathId);
    await clearActiveCommitment(userId);

    // The unfinished step is shut...
    const verdict = await courseEnterVerdict(userId, s2);
    expect(verdict.enterable).toBe(false);
    expect(verdict.activatePathId).toBe(String(pathId));
    // ...but progress survives, and the finished one is still readable.
    await expect(courseEnterVerdict(userId, s1)).resolves.toMatchObject({ enterable: true });
    const enrollment = await EnrollmentModel.findOne({
      userId: new Types.ObjectId(userId),
      courseId: s1,
    }).lean();
    expect(enrollment?.completedLessonIds).toHaveLength(LESSONS);
  });

  it("leaves a path-less course open until another one holds the standalone slot", async () => {
    const solo = await makeCourse("Standalone");
    const other = await makeCourse("Other standalone");
    const pathId = await makePath("Path A");
    await makeCourse("A step 1", pathId, 1);

    // Nothing committed: there is no path to activate, so denying access would
    // leave the student with no move to make.
    await expect(courseEnterVerdict(userId, solo)).resolves.toMatchObject({ enterable: true });

    // An active PATH does not compete for the standalone slot, so it stays open.
    await setActivePath(userId, String(pathId));
    await expect(courseEnterVerdict(userId, solo)).resolves.toMatchObject({ enterable: true });

    // Another standalone course taking the slot is what shuts it.
    await setActiveCourse(userId, other);
    expect((await courseEnterVerdict(userId, solo)).enterable).toBe(false);
    await expect(courseEnterVerdict(userId, other)).resolves.toMatchObject({ enterable: true });
  });

  it("locks the projects of a course that is not open", async () => {
    const pathA = await makePath("Path A");
    const a1 = await makeCourse("A step 1", pathA, 1);
    const pathB = await makePath("Path B");
    const b1 = await makeCourse("B step 1", pathB, 1);
    await setActivePath(userId, String(pathA));

    const inPath = { courseId: a1, chapterIndex: 0 };
    const outside = { courseId: b1, chapterIndex: 0 };
    const locks = await projectLocks(userId, [inPath, outside]);

    // Inside the active path the chapter gate still applies, and says so.
    expect(locks.get(inPath)!.lockReason).toContain("Chapter 1");
    // Outside it, the commitment gate wins and names the actionable fix.
    expect(locks.get(outside)!.locked).toBe(true);
    expect(locks.get(outside)!.lockReason).toContain("Path B");
  });
});

describe("standalone courses", () => {
  it("carry their own lock, exactly like a path", async () => {
    const solo = await makeCourse("Standalone");
    const other = await makeCourse("Other standalone");

    const state = await setActiveCourse(userId, solo);
    expect(state.primary!.kind).toBe("course");
    expect(state.primary!.canDeactivate).toBe(false);
    await expect(setActiveCourse(userId, other)).rejects.toMatchObject({ statusCode: 409 });

    await CourseModel.updateOne(
      { _id: solo },
      { $set: { lockedUntil: new Date(Date.now() - 1000) } },
    );
    await clearActiveCommitment(userId);
    // The one just switched off is locked; the other never was.
    await expect(setActiveCourse(userId, solo)).rejects.toMatchObject({ statusCode: 409 });
    const next = await setActiveCourse(userId, other);
    expect(next.primary!.kind).toBe("course");
  });

  it("activating a course inside a path commits to the whole path", async () => {
    const pathId = await makePath("Full Stack");
    await makeCourse("Step 1", pathId, 1);
    const s2 = await makeCourse("Step 2", pathId, 2);

    const state = await setActiveCourse(userId, s2);
    expect(state.primary!.kind).toBe("path");
    expect(state.primary!.pathId).toBe(String(pathId));
    expect(state.primary!.currentCourseId).not.toBe(s2); // still step 1's turn
  });
});

describe("self-healing", () => {
  it("forgets a deleted active path", async () => {
    const pathId = await makePath("Path A");
    await makeCourse("A step 1", pathId, 1);
    await setActivePath(userId, String(pathId));
    await LearningPathModel.deleteOne({ _id: pathId });

    const state = await getActiveState(userId);
    expect(state.commitments).toHaveLength(0);
    // And the stale id is pulled from the user, not merely filtered on read.
    const user = await UserModel.findById(userId).select("activePathIds").lean();
    expect(user!.activePathIds).toHaveLength(0);
  });

  it("keeps the surviving paths when one of several is deleted", async () => {
    await setPlan("pro");
    const p1 = await makePath("First");
    const p2 = await makePath("Second");
    await makeCourse("first step", p1, 1);
    await makeCourse("second step", p2, 1);
    await setActivePath(userId, String(p1));
    await setActivePath(userId, String(p2));

    await LearningPathModel.deleteOne({ _id: p1 });

    const state = await getActiveState(userId);
    expect(state.commitments).toHaveLength(1);
    expect(forPath(state, p2)).toBeDefined();
  });
});
