import { getProfile } from "../../services/user.service.js";
import { getStats } from "../../services/stats.service.js";
import { listEnrollments } from "../../services/progress.service.js";
import { listMyProjects } from "../../services/projectProgress.service.js";
import { listCourses } from "../../services/course.service.js";
import { listProjects } from "../../services/project.service.js";
import { getMyProfileTool, getMyProgressTool } from "./prompts/student.js";
import { failure, type RegisteredTool } from "./types.js";

const getMyProfile: RegisteredTool = {
  schema: getMyProfileTool,
  runningLabel: () => "Reading profile",
  run: async (ctx) => {
    try {
      const p = await getProfile(ctx.userId);
      const lines = [
        `Name: ${p.name}`,
        `Username: ${p.username}`,
        `Email: ${p.email}`,
        p.country && `Country: ${p.country}`,
        p.timezone && `Timezone: ${p.timezone}`,
        p.language && `Preferred language: ${p.language}`,
        p.bio && `Bio: ${p.bio}`,
        `Member since: ${p.memberSince.slice(0, 10)}`,
      ].filter(Boolean);
      return { ok: true, label: "Profile loaded", modelText: lines.join("\n") };
    } catch (err) {
      return failure("Couldn't read profile", err);
    }
  },
};

const getMyProgress: RegisteredTool = {
  schema: getMyProgressTool,
  runningLabel: () => "Reading progress",
  run: async (ctx) => {
    try {
      const [stats, enrollments, projectProgress, courses, projects] = await Promise.all([
        getStats(ctx.userId),
        listEnrollments(ctx.userId),
        listMyProjects(ctx.userId),
        listCourses(ctx.userId),
        listProjects(ctx.userId),
      ]);

      const courseTitle = new Map(courses.map((c) => [String(c._id), c.title]));
      const projectTitle = new Map(projects.map((p) => [String(p._id), p.title]));
      const weekHours = stats.studyByDay.reduce((sum, d) => sum + d.hours, 0);

      const lines = [
        `Courses enrolled: ${stats.coursesEnrolled}; lessons completed: ${stats.lessonsCompleted}; routine tasks completed: ${stats.tasksCompleted}`,
        `Quizzes taken: ${stats.quizzesTaken} (average score ${stats.quizAvg}%, ${stats.quizzes90} scored 90+)`,
        `Total study time: ${stats.studyTimeLabel}; last 7 days: ${weekHours.toFixed(1)}h`,
        `Projects completed: ${stats.projectsCompleted}`,
        stats.achievements.length
          ? `Achievements: ${stats.achievements.map((a) => a.name).join(", ")}`
          : "Achievements: none yet",
      ];

      if (enrollments.length) {
        lines.push("Enrollments:");
        for (const e of enrollments.slice(0, 20)) {
          const title = courseTitle.get(e.courseId) ?? `course ${e.courseId}`;
          lines.push(`- "${title}" — ${e.completedLessonIds?.length ?? 0} lessons completed`);
        }
      }
      if (projectProgress.length) {
        lines.push("Project statuses:");
        for (const p of projectProgress.slice(0, 20)) {
          const title = projectTitle.get(p.projectId) ?? `project ${p.projectId}`;
          lines.push(`- "${title}" — ${p.status}`);
        }
      }

      return { ok: true, label: "Progress loaded", modelText: lines.join("\n") };
    } catch (err) {
      return failure("Couldn't read progress", err);
    }
  },
};

export const studentTools = [getMyProfile, getMyProgress];
