import { Types } from "mongoose";
import { entitlementsFor } from "../config/entitlements.js";
import type { PlanId } from "../config/plans.js";
import { CourseModel } from "../database/models/course.model.js";
import { EnrollmentModel } from "../database/models/enrollment.model.js";
import { LearningPathModel } from "../database/models/learningPath.model.js";
import { UserModel } from "../database/models/user.model.js";
import { ApiError } from "../utils/apiError.js";

/**
 * What the student has committed to, and therefore what they may study.
 *
 * The unit of commitment is the LEARNING PATH. Activating one opens its ordered
 * courses, which then unlock a step at a time as each is finished; a standalone
 * course (belonging to no path) can be committed to on its own. The active
 * path's current step automatically fills the "active course" slot — it is
 * derived from progress, never chosen.
 *
 * ---------------------------------------------------------------------------
 * How many at once: the plan decides
 * ---------------------------------------------------------------------------
 * Basic 1 path, Pro 2, Premium 3 (config/entitlements.ts), plus ONE standalone
 * course on every tier. Paths and the standalone course are independent slots:
 * having a path running does not stop a path-less course being committed to,
 * and vice versa.
 *
 * The cap is checked when ACTIVATING and never when reading. That is what makes
 * a downgrade non-destructive: someone who drops from Premium to Basic keeps
 * all three paths running and simply cannot start a fourth. Nothing is switched
 * off behind their back, and nothing they were part-way through disappears.
 *
 * ---------------------------------------------------------------------------
 * The lock is PER PATH, and it cuts both ways
 * ---------------------------------------------------------------------------
 * Each path (and standalone course) carries its own `lockedUntil`. Which
 * direction it blocks depends on whether that path is currently active:
 *
 *   activate P  ->  P.lockedUntil = now + 3d, and P is active
 *                   => P cannot be DEACTIVATED for 3 days
 *   deactivate P->  P.lockedUntil = now + 3d, and P is inactive
 *                   => P cannot be REACTIVATED for 3 days
 *
 * Because the lock rides on the path rather than on the student, switching one
 * path off never delays starting another. The worked example:
 *
 *   t=0   A and B both inactive, unlocked      -> may activate either
 *   t=0   activate A                           -> A locked (as active) to t=3d
 *   t=3d  deactivate A                         -> A locked (as inactive) to t=6d
 *   t=3d  activate B immediately               -> B locked (as active) to t=6d
 *
 * Committing is meant to be a decision rather than a click, and on a one-path
 * plan that still holds: the slot is full, so starting something else means
 * consciously giving up what is running.
 */

export const COOLDOWN_DAYS = 3;
const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

export type StepStatus = "done" | "current" | "locked";

export interface PathStep {
  courseId: string;
  title: string;
  order: number;
  progress: number;
  lessons: number;
  /** Lessons finished, so a card can say "2 of 25" and not just a percent. */
  completedLessons: number;
  desc: string;
  level: string;
  icon: string;
  status: StepStatus;
  /** Why this step is shut, empty when it is not. */
  lockReason: string;
}

export interface ActiveCommitment {
  kind: "path" | "course";
  pathId: string | null;
  /** The career goal the path was built for — its student-facing name. */
  goal: string | null;
  /** Standalone commitments only. */
  courseId: string | null;
  /** The course to study right now: the current step, or the standalone course. */
  currentCourseId: string | null;
  steps: PathStep[];
  activeSince: Date | null;
  /** This commitment's own lock — while it runs, it cannot be switched off. */
  lockedUntil: Date | null;
  canDeactivate: boolean;
}

/** Every commitment at once, with the room left to add another. */
export interface ActiveState {
  /** Newest first, so `commitments[0]` is what to resume. */
  commitments: ActiveCommitment[];
  /** The same object as `commitments[0]`, named for the callers that want one. */
  primary: ActiveCommitment | null;
  limits: { paths: number; courses: number };
  counts: { paths: number; courses: number };
  canActivatePath: boolean;
  canActivateCourse: boolean;
}

function isLocked(lockedUntil: Date | null | undefined): boolean {
  return Boolean(lockedUntil && lockedUntil.getTime() > Date.now());
}

/** 409, not 403: the caller is allowed to do this in general, it just
 *  conflicts with the cooldown this path is currently inside. */
function lockedError(lockedUntil: Date): ApiError {
  return new ApiError(409, `Locked until ${lockedUntil.toISOString()}.`);
}

function pct(doneCount: number, lessons: number): number {
  return Math.min(100, Math.round((doneCount / (lessons || 1)) * 100));
}

/**
 * The ordered steps of one path with each course's progress and gate state.
 *
 * The single source of the "step N opens when N-1 is finished" rule. Everything
 * that needs it — the panel, the card grid, the course page, the server-side
 * enter gate — reads it from here, so they cannot drift apart.
 */
export async function buildPathSteps(userId: string, pathId: string): Promise<PathStep[]> {
  const uid = new Types.ObjectId(userId);
  const courses = await CourseModel.find({ userId: uid, pathId: new Types.ObjectId(pathId) })
    .select("title order lessons desc level icon")
    .sort({ order: 1 })
    .lean();
  if (courses.length === 0) return [];

  const enrollments = await EnrollmentModel.find({
    userId: uid,
    courseId: { $in: courses.map((c) => String(c._id)) },
  })
    .select("courseId completedLessonIds")
    .lean();
  const doneByCourse = new Map(
    enrollments.map((e) => [e.courseId, e.completedLessonIds?.length ?? 0]),
  );

  const steps: PathStep[] = [];
  // "The first unfinished step is current, everything after it is locked" —
  // walked in order rather than compared pairwise so a gap in `order` (a course
  // deleted out of the middle of a path) can't strand the rest as unreachable.
  let currentTaken = false;
  for (const [i, course] of courses.entries()) {
    const id = String(course._id);
    const completedLessons = doneByCourse.get(id) ?? 0;
    const progress = pct(completedLessons, course.lessons ?? 0);
    const done = progress >= 100;

    let status: StepStatus;
    let lockReason = "";
    if (done) {
      status = "done";
    } else if (!currentTaken) {
      status = "current";
      currentTaken = true;
    } else {
      status = "locked";
      lockReason = `Finish "${courses[i - 1]?.title ?? `step ${i}`}" to unlock this course`;
    }

    steps.push({
      courseId: id,
      title: course.title,
      order: course.order ?? i + 1,
      progress,
      lessons: course.lessons ?? 0,
      completedLessons,
      desc: course.desc ?? "",
      level: course.level ?? "Beginner",
      icon: course.icon ?? "book",
      status,
      lockReason,
    });
  }
  return steps;
}

/** One active path as a commitment, or null if it no longer holds together. */
async function buildPathCommitment(
  userId: string,
  pathId: string,
): Promise<ActiveCommitment | null> {
  const path = await LearningPathModel.findOne({
    _id: pathId,
    userId: new Types.ObjectId(userId),
  })
    .select("goal lockedUntil activatedAt")
    .lean();
  if (!path) return null;

  const steps = await buildPathSteps(userId, pathId);
  if (steps.length === 0) return null;

  const lockedUntil = path.lockedUntil ?? null;
  return {
    kind: "path",
    pathId,
    goal: path.goal,
    courseId: null,
    // Every step done → the path is finished; nothing left to continue, but
    // the commitment stands so it can still be reviewed.
    currentCourseId: steps.find((s) => s.status === "current")?.courseId ?? null,
    steps,
    activeSince: path.activatedAt ?? null,
    lockedUntil,
    canDeactivate: !isLocked(lockedUntil),
  };
}

async function buildCourseCommitment(
  userId: string,
  courseId: string,
): Promise<ActiveCommitment | null> {
  if (!Types.ObjectId.isValid(courseId)) return null;
  const uid = new Types.ObjectId(userId);
  const course = await CourseModel.findOne({ _id: courseId, userId: uid })
    .select("title lessons desc level icon lockedUntil activatedAt")
    .lean();
  if (!course) return null;

  const enrollment = await EnrollmentModel.findOne({ userId: uid, courseId })
    .select("completedLessonIds")
    .lean();
  const lockedUntil = course.lockedUntil ?? null;
  const completedLessons = enrollment?.completedLessonIds?.length ?? 0;

  return {
    kind: "course",
    pathId: null,
    goal: null,
    courseId,
    currentCourseId: courseId,
    // A standalone commitment is a one-step "path", so the panel can render
    // both kinds from the same array instead of branching on kind.
    steps: [
      {
        courseId,
        title: course.title,
        order: 1,
        progress: pct(completedLessons, course.lessons ?? 0),
        lessons: course.lessons ?? 0,
        completedLessons,
        desc: course.desc ?? "",
        level: course.level ?? "Beginner",
        icon: course.icon ?? "book",
        status: "current",
        lockReason: "",
      },
    ],
    activeSince: course.activatedAt ?? null,
    lockedUntil,
    canDeactivate: !isLocked(lockedUntil),
  };
}

/**
 * Every commitment the student currently holds, newest first.
 *
 * Self-heals: a path or course that has since been deleted is dropped from the
 * user's active list rather than reported. The cooldown deliberately survives
 * that cleanup — deleting the thing you committed to must not be a back door
 * out of the commitment.
 */
export async function getActiveCommitments(userId: string): Promise<ActiveCommitment[]> {
  const user = await UserModel.findById(userId)
    .select("activePathIds activeCourseId activeSince")
    .lean();
  if (!user) return [];

  const pathIds = (user.activePathIds ?? []).map(String);
  const built = await Promise.all(pathIds.map((id) => buildPathCommitment(userId, id)));

  const stale = pathIds.filter((_, i) => built[i] === null);
  if (stale.length) {
    await UserModel.updateOne(
      { _id: userId },
      { $pull: { activePathIds: { $in: stale.map((id) => new Types.ObjectId(id)) } } },
    );
  }

  const commitments = built.filter((c): c is ActiveCommitment => c !== null);

  if (user.activeCourseId) {
    const course = await buildCourseCommitment(userId, user.activeCourseId);
    if (course) {
      // Written before this field existed, or activated before `activatedAt`
      // was recorded — fall back to the user-level stamp so it still sorts.
      course.activeSince = course.activeSince ?? user.activeSince ?? null;
      commitments.push(course);
    } else {
      await UserModel.updateOne(
        { _id: userId },
        { $set: { activeCourseId: null, activeSince: null } },
      );
    }
  }

  return commitments.sort(
    (a, b) => (b.activeSince?.getTime() ?? 0) - (a.activeSince?.getTime() ?? 0),
  );
}

/**
 * The whole commitment picture in one call: what is running, and whether
 * there is room to start anything else.
 *
 * The room figures are what let the UI grey an "Activate" button and say why,
 * instead of offering an action the server will refuse.
 */
export async function getActiveState(userId: string): Promise<ActiveState> {
  const [user, commitments] = await Promise.all([
    UserModel.findById(userId).select("plan").lean(),
    getActiveCommitments(userId),
  ]);

  const limits = entitlementsFor((user?.plan ?? null) as PlanId | null);
  const paths = commitments.filter((c) => c.kind === "path").length;
  const courses = commitments.filter((c) => c.kind === "course").length;

  return {
    commitments,
    primary: commitments[0] ?? null,
    limits: { paths: limits.activePaths, courses: limits.activeCourses },
    counts: { paths, courses },
    canActivatePath: paths < limits.activePaths,
    canActivateCourse: courses < limits.activeCourses,
  };
}

/** 409 naming what is in the way, so the UI can show it verbatim. */
function atPathLimitError(active: ActiveCommitment[], limit: number): ApiError {
  const names = active
    .filter((c) => c.kind === "path")
    .map((c) => `"${c.goal ?? "a path"}"`)
    .join(", ");
  return new ApiError(
    409,
    limit === 1
      ? `${names} is active. Deactivate it first, then activate this one.`
      : `Your plan allows ${limit} active learning paths and you already have ${names}. ` +
        `Deactivate one, or upgrade your plan.`,
  );
}

/**
 * Commit to a learning path.
 *
 * Refused when the plan's path slots are full, and refused while THIS path is
 * still inside its own deactivation cooldown. Switching is deliberately two
 * steps on a one-path plan — that is what makes the commitment a decision
 * rather than a click.
 */
export async function setActivePath(userId: string, pathId: string): Promise<ActiveState> {
  if (!Types.ObjectId.isValid(pathId)) throw new ApiError(404, "Learning path not found");
  const path = await LearningPathModel.findOne({
    _id: pathId,
    userId: new Types.ObjectId(userId),
  })
    .select("goal lockedUntil")
    .lean();
  if (!path) throw new ApiError(404, "Learning path not found");

  const state = await getActiveState(userId);
  if (state.commitments.some((c) => c.pathId === String(path._id))) return state; // already active
  if (!state.canActivatePath) {
    throw atPathLimitError(state.commitments, state.limits.paths);
  }
  // Left over from the last time this path was switched off.
  if (isLocked(path.lockedUntil)) throw lockedError(path.lockedUntil!);

  const now = new Date();
  const until = new Date(now.getTime() + COOLDOWN_MS);
  await Promise.all([
    // $addToSet, not $push: two clicks racing must not seat the same path twice.
    UserModel.updateOne(
      { _id: userId },
      { $addToSet: { activePathIds: new Types.ObjectId(String(path._id)) } },
    ),
    // Activating starts the "you committed, stay a while" window — this is what
    // stops the path being switched off again for the next three days.
    LearningPathModel.updateOne(
      { _id: path._id },
      { $set: { lockedUntil: until, activatedAt: now } },
    ),
  ]);
  return getActiveState(userId);
}

/**
 * Commit to a course. A course that belongs to a path commits to the PATH
 * instead — activating a single step would split the sequence the path exists
 * to express, so the card action can never produce that state.
 *
 * Standalone courses have their own slot (one on every tier), so this is not
 * blocked by an active path — only by another standalone course.
 */
export async function setActiveCourse(userId: string, courseId: string): Promise<ActiveState> {
  if (!Types.ObjectId.isValid(courseId)) throw new ApiError(404, "Course not found");
  const course = await CourseModel.findOne({
    _id: courseId,
    userId: new Types.ObjectId(userId),
  })
    .select("title pathId lockedUntil")
    .lean();
  if (!course) throw new ApiError(404, "Course not found");

  if (course.pathId) return setActivePath(userId, String(course.pathId));

  const state = await getActiveState(userId);
  if (state.commitments.some((c) => c.courseId === String(course._id))) return state;
  if (!state.canActivateCourse) {
    const running = state.commitments.find((c) => c.kind === "course");
    throw new ApiError(
      409,
      `"${running?.steps[0]?.title ?? "Another course"}" is active. Deactivate it first, then activate this one.`,
    );
  }
  if (isLocked(course.lockedUntil)) throw lockedError(course.lockedUntil!);

  const now = new Date();
  const until = new Date(now.getTime() + COOLDOWN_MS);
  await Promise.all([
    UserModel.updateOne(
      { _id: userId },
      { $set: { activeCourseId: String(course._id), activeSince: now } },
    ),
    CourseModel.updateOne({ _id: course._id }, { $set: { lockedUntil: until, activatedAt: now } }),
  ]);
  return getActiveState(userId);
}

/**
 * Switch one commitment off: its courses and projects lock again. Progress is
 * untouched, so reactivating later resumes at the same step.
 *
 * Refused while that commitment's active lock is still running — that window is
 * the point of committing. Once it succeeds, THIS path is locked out of being
 * reactivated for three days, while every other path stays immediately
 * available.
 *
 * With no target, the most recently activated commitment is the one switched
 * off; that is what a bare "deactivate" button on the resume hero means.
 */
export async function clearActiveCommitment(
  userId: string,
  target?: { pathId?: string; courseId?: string },
): Promise<ActiveState> {
  const state = await getActiveState(userId);

  const chosen = target?.pathId
    ? state.commitments.find((c) => c.pathId === target.pathId)
    : target?.courseId
      ? state.commitments.find((c) => c.courseId === target.courseId)
      : state.primary;

  if (!chosen) {
    // Nothing to give up. Naming a commitment that is not active is a no-op
    // rather than an error: the usual cause is a stale tab, and the state that
    // comes back tells it the truth.
    return state;
  }
  if (isLocked(chosen.lockedUntil)) throw lockedError(chosen.lockedUntil!);

  const until = new Date(Date.now() + COOLDOWN_MS);
  if (chosen.kind === "path") {
    await Promise.all([
      UserModel.updateOne(
        { _id: userId },
        { $pull: { activePathIds: new Types.ObjectId(chosen.pathId!) } },
      ),
      LearningPathModel.updateOne({ _id: chosen.pathId }, { $set: { lockedUntil: until } }),
    ]);
  } else {
    await Promise.all([
      UserModel.updateOne({ _id: userId }, { $set: { activeCourseId: null, activeSince: null } }),
      CourseModel.updateOne({ _id: chosen.courseId }, { $set: { lockedUntil: until } }),
    ]);
  }
  return getActiveState(userId);
}

export interface EnterVerdict {
  enterable: boolean;
  /** Student-facing sentence, empty when enterable. */
  reason: string;
  /** The path to activate to fix it, when that is the fix. */
  activatePathId: string | null;
}

const ENTERABLE: EnterVerdict = { enterable: true, reason: "", activatePathId: null };

/**
 * May this course be studied right now?
 *
 *   completed                     -> yes, always (a finished course stays readable)
 *   in one of the active paths    -> yes if its step gate is open
 *   is the active standalone      -> yes
 *   path-less, no standalone held -> yes (see below)
 *   otherwise                     -> no
 *
 * A path's courses are locked whenever that path is not active — that is the
 * whole point of the switch, and it holds even when nothing at all is active.
 * The student is not stranded by it, because deactivating one path leaves every
 * OTHER path immediately activatable: the cooldown rides on the path that was
 * switched off, not on the student.
 *
 * A course belonging to NO path is treated differently on purpose. There is no
 * sequence to protect and no path to activate, so gating it on an empty slot
 * would deny access with no action the student could take to fix it. It is
 * still blocked while a DIFFERENT standalone course holds the slot. Active
 * paths do not block it: paths and standalone courses are independent slots.
 */
export async function courseEnterVerdict(
  userId: string,
  courseId: string,
): Promise<EnterVerdict> {
  if (!Types.ObjectId.isValid(courseId)) return ENTERABLE;
  const uid = new Types.ObjectId(userId);
  const course = await CourseModel.findOne({ _id: courseId, userId: uid })
    .select("title lessons pathId pathTitle")
    .lean();
  if (!course) return ENTERABLE; // not theirs — other layers 404 it

  const enrollment = await EnrollmentModel.findOne({ userId: uid, courseId })
    .select("completedLessonIds")
    .lean();
  if (pct(enrollment?.completedLessonIds?.length ?? 0, course.lessons ?? 0) >= 100) {
    return ENTERABLE;
  }

  const commitments = await getActiveCommitments(userId);

  if (course.pathId) {
    const pathId = String(course.pathId);
    const active = commitments.find((c) => c.pathId === pathId);
    if (!active) {
      return {
        enterable: false,
        reason: `Activate the "${course.pathTitle ?? "learning"}" path to study this course.`,
        activatePathId: pathId,
      };
    }
    const step = active.steps.find((s) => s.courseId === String(course._id));
    if (!step || step.status !== "locked") return ENTERABLE;
    return { enterable: false, reason: step.lockReason, activatePathId: null };
  }

  const standalone = commitments.find((c) => c.kind === "course");
  if (!standalone) return ENTERABLE; // the slot is free — nothing to unlock
  if (standalone.courseId === String(course._id)) return ENTERABLE;
  return {
    enterable: false,
    reason: `"${standalone.steps[0]?.title ?? "Another course"}" is active. Deactivate it first to study this.`,
    activatePathId: null,
  };
}

export async function assertCourseEnterable(userId: string, courseId: string): Promise<void> {
  const verdict = await courseEnterVerdict(userId, courseId);
  if (!verdict.enterable) throw new ApiError(403, verdict.reason);
}
