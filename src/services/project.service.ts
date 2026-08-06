import { Types } from "mongoose";
import { makeProjectRequirements } from "../agents/project-requirements/index.js";
import { CourseModel } from "../database/models/course.model.js";
import { ProjectModel } from "../database/models/project.model.js";
import { ApiError } from "../utils/apiError.js";

export interface ProjectInput {
  title: string;
  desc?: string;
  goal?: string;
  requirements?: string[];
  tags?: string[];
  icon?: string;
  thumb?: string;
  featured?: boolean;
  courseId?: string;
  chapterIndex?: number;
  order?: number;
  difficulty?: "starter" | "practice" | "capstone";
  estimatedHours?: number;
}

/** The course title a project belongs to, when it belongs to one we can read. */
async function courseTitleFor(userId: string, courseId?: string): Promise<string | undefined> {
  if (!courseId || !Types.ObjectId.isValid(courseId)) return undefined;
  const course = await CourseModel.findOne({ _id: courseId, userId: new Types.ObjectId(userId) })
    .select("title")
    .lean();
  return course?.title;
}

async function authorRequirements(
  userId: string,
  input: { title: string; desc?: string; tags?: string[]; courseId?: string },
) {
  return makeProjectRequirements({
    title: input.title,
    desc: input.desc ?? "",
    tags: input.tags ?? [],
    courseTitle: await courseTitleFor(userId, input.courseId),
  });
}

export async function createProject(userId: string, input: ProjectInput) {
  // The requirements are what a submission is later reviewed against, so they
  // are authored up front — but a failing LLM must never block project
  // creation. An empty checklist is backfilled on first read (ensureRequirements).
  // The project planner supplies its own `goal`, which skips this call entirely:
  // that is what keeps a 10-project course from costing 10 extra LLM calls.
  let authored: { goal: string; requirements: string[] } | null = null;
  if (!input.goal && !input.requirements?.length) {
    try {
      authored = await authorRequirements(userId, input);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[project-requirements] create-time authoring failed for "${input.title}":`, err);
    }
  }

  const project = await ProjectModel.create({
    userId: new Types.ObjectId(userId),
    ...input,
    ...(authored ?? {}),
  });
  return project.toObject();
}

export async function listProjects(userId: string) {
  return ProjectModel.find({ userId: new Types.ObjectId(userId) })
    .sort({ createdAt: -1 })
    .lean();
}

async function findOwned(userId: string, id: string) {
  if (!Types.ObjectId.isValid(id)) throw new ApiError(400, "Invalid project id");
  const project = await ProjectModel.findOne({ _id: id, userId });
  if (!project) throw new ApiError(404, "Project not found");
  return project;
}

export async function getProject(userId: string, id: string) {
  return (await findOwned(userId, id)).toObject();
}

/**
 * Same-process dedupe: concurrent detail reads of one project share a single
 * authoring run rather than each paying for an LLM call.
 */
const inFlight = new Map<string, Promise<void>>();

/**
 * Fills in the goal/requirements of a project that predates the reviewer (or
 * whose create-time authoring failed), then returns the project. Authoring
 * failures are swallowed — a project detail page must still render, just
 * without a checklist.
 */
export async function getProjectWithRequirements(userId: string, id: string) {
  const project = (await findOwned(userId, id)).toObject();
  if (project.goal && project.requirements.length) return project;

  const job =
    inFlight.get(id) ??
    (async () => {
      const authored = await authorRequirements(userId, {
        title: project.title,
        desc: project.desc,
        tags: project.tags,
        courseId: project.courseId,
      });
      await ProjectModel.updateOne({ _id: id, userId }, { $set: authored });
    })().finally(() => inFlight.delete(id));
  inFlight.set(id, job);

  try {
    await job;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[project-requirements] backfill failed for "${project.title}":`, err);
    return project;
  }
  return (await findOwned(userId, id)).toObject();
}

export async function updateProject(userId: string, id: string, patch: Partial<ProjectInput>) {
  const project = await findOwned(userId, id);
  Object.assign(project, patch);
  await project.save();
  return project.toObject();
}

export async function deleteProject(userId: string, id: string) {
  await findOwned(userId, id);
  await ProjectModel.deleteOne({ _id: id, userId });
}
