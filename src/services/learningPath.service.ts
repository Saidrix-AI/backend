import type { CurriculumRef } from "../rag/curriculum.js";
import { Types } from "mongoose";
import { LearningPathModel } from "../database/models/learningPath.model.js";
import { buildPathSteps, getActiveState, type PathStep } from "./activeSelection.service.js";

export interface PathCourse {
  title: string;
  objective: string;
  level?: "Beginner" | "Intermediate" | "Advanced";
  covers?: string;
  /** 1-3 words naming the step, listed down the side of the path. */
  theme?: string;
  /** The curriculum template course this step comes from, if any. */
  template?: CurriculumRef | null;
}

/** Persists a proposed multi-course path; returns the saved doc (with its _id). */
export async function createLearningPath(
  userId: string,
  goal: string,
  courses: PathCourse[],
  summary = "",
) {
  const path = await LearningPathModel.create({
    userId: new Types.ObjectId(userId),
    goal,
    summary,
    courses,
  });
  return path.toObject();
}

/** A step as the Courses page lists it — a generated course, or one still only proposed. */
export type PathListStep =
  | PathStep
  | (Omit<PathStep, "status"> & {
      status: "planned";
      /** What the course will teach — shown on the card before it exists. */
      objective: string;
    });

/**
 * The proposed-but-not-generated steps of a path, merged in order with the
 * generated ones. Generated steps keep the state buildPathSteps gave them; a
 * planned step has no course yet, so it has no progress and no gate — only a
 * "Create course" button.
 */
function mergePlanned(
  generated: PathStep[],
  proposed: { title: string; objective: string; level?: string | null }[],
): PathListStep[] {
  const taken = new Set(generated.map((s) => s.order));
  const planned: PathListStep[] = proposed.flatMap((c, i) =>
    taken.has(i + 1)
      ? []
      : [
          {
            courseId: "",
            title: c.title,
            order: i + 1,
            progress: 0,
            lessons: 0,
            completedLessons: 0,
            desc: "",
            level: c.level ?? "Beginner",
            icon: "book",
            status: "planned" as const,
            lockReason: "",
            objective: c.objective,
          },
        ],
  );
  return [...generated, ...planned].sort((a, b) => a.order - b.order);
}

export interface PathSummary {
  pathId: string;
  goal: string;
  /** One line under the goal. Empty on paths proposed before the field existed. */
  summary: string;
  /** The proposal's short label per step, index-aligned to `steps`. An entry is
   *  empty when the path predates `theme` or a course could not be matched. */
  themes: string[];
  active: boolean;
  total: number;
  completed: number;
  /** Percent of the path's courses finished — the headline number on the panel. */
  progress: number;
  /** Every step of the path in order: the generated courses (with their gate
   *  state) and, between and after them, the proposed ones not created yet
   *  (`status: "planned"`, empty `courseId`). */
  steps: PathListStep[];
  /** This path's own cooldown. While active it blocks switching OFF; while
   *  inactive it blocks switching back ON. */
  lockedUntil: Date | null;
  canActivate: boolean;
  /** Why the Activate button is disabled, empty when it isn't. */
  blockedReason: string;
}

/**
 * Every path this student owns, with its generated courses in order and each
 * one's gate state. Paths whose courses were never generated are dropped:
 * a LearningPath doc is written when courses are *proposed*, so an abandoned
 * proposal would otherwise show up as an empty, unactivatable path.
 *
 * Step states come from buildPathSteps so this list, the active panel and the
 * server-side enter gate all read the same rule.
 */
export async function listPathsWithCourses(userId: string): Promise<PathSummary[]> {
  const [paths, active] = await Promise.all([
    LearningPathModel.find({ userId: new Types.ObjectId(userId) })
      .select("goal summary courses lockedUntil")
      .sort({ createdAt: -1 })
      .lean(),
    getActiveState(userId),
  ]);
  // "No room for another path" — either the plan's slots are full or, on a
  // one-path plan, something is simply already running. The distinction the
  // student cares about is the same either way: this one cannot start yet.
  const slotsFull = !active.canActivatePath;
  const activePathIds = new Set(
    active.commitments.filter((c) => c.kind === "path").map((c) => c.pathId),
  );

  const out: PathSummary[] = [];
  for (const path of paths) {
    const generated = await buildPathSteps(userId, String(path._id));
    // Still only shown once the student has built something from it: every
    // proposal writes a path, and the ones never acted on are not a plan.
    if (generated.length === 0) continue;
    const steps = mergePlanned(generated, path.courses ?? []);
    const completed = steps.filter((s) => s.status === "done").length;
    const isActive = activePathIds.has(String(path._id));
    const lockedUntil = path.lockedUntil ?? null;
    const stillLocked = Boolean(lockedUntil && lockedUntil.getTime() > Date.now());

    // Two different reasons the button is off, and they need different words:
    // this path is cooling down after being switched off, versus something else
    // holds the slot and has to be switched off first.
    let blockedReason = "";
    if (!isActive) {
      if (stillLocked) blockedReason = "Recently deactivated — locked for now";
      else if (slotsFull) {
        const running = active.commitments
          .filter((c) => c.kind === "path")
          .map((c) => `"${c.goal ?? "a path"}"`)
          .join(", ");
        blockedReason =
          active.limits.paths === 1
            ? `${running || "Another path"} is active — deactivate it first`
            : `Your plan allows ${active.limits.paths} active paths and ${running} are running — deactivate one, or upgrade`;
      }
    }

    // `order` is the proposal's 1-based position, so it indexes `path.courses`
    // directly. Going through it rather than the loop counter keeps the labels
    // attached to the right step when a course was deleted out of the middle.
    const themes = steps.map((s) => path.courses?.[s.order - 1]?.theme ?? "");

    out.push({
      pathId: String(path._id),
      goal: path.goal,
      summary: path.summary ?? "",
      themes,
      active: isActive,
      total: steps.length,
      completed,
      progress: Math.round((completed / steps.length) * 100),
      steps,
      lockedUntil,
      canActivate: !isActive && !stillLocked && !slotsFull,
      blockedReason,
    });
  }
  return out;
}

/** Loads a path owned by this user, or null (invalid id / not found / not theirs). */
export async function getLearningPath(userId: string, pathId: string) {
  if (!Types.ObjectId.isValid(pathId)) return null;
  return LearningPathModel.findOne({ _id: pathId, userId: new Types.ObjectId(userId) }).lean();
}

export type LearningPathDoc = Awaited<ReturnType<typeof getLearningPath>>;

/** The student's most recently proposed path — what a "Create these courses" reply refers to. */
export async function latestLearningPath(userId: string) {
  return LearningPathModel.findOne({ userId: new Types.ObjectId(userId) }).sort({ createdAt: -1 }).lean();
}

/**
 * Finds the path + 1-based order of the entry matching this course, by objective
 * (or title hint). Lets a course generated from a proposal auto-link to its path
 * without the model having to pass pathId/order — group creation "just works".
 * Prefers the most recent path when several match.
 */
export async function findPathEntryByObjective(
  userId: string,
  objective: string,
  titleHint?: string,
): Promise<{ path: NonNullable<LearningPathDoc>; order: number } | null> {
  const norm = (s: string) => s.trim().toLowerCase();
  const target = norm(objective);
  const hint = titleHint ? norm(titleHint) : "";
  const paths = await LearningPathModel.find({ userId: new Types.ObjectId(userId) })
    .sort({ createdAt: -1 })
    .lean();
  for (const path of paths) {
    const idx = path.courses.findIndex(
      (c) => norm(c.objective) === target || (hint !== "" && norm(c.title) === hint),
    );
    if (idx >= 0) return { path, order: idx + 1 };
  }
  return null;
}
