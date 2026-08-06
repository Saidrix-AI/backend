import { Types } from "mongoose";
import { AchievementModel } from "../database/models/achievement.model.js";
import { StudySessionModel } from "../database/models/studySession.model.js";
import { getProgressCounts } from "./progress.service.js";

export interface UserStats {
  coursesEnrolled: number;
  lessonsCompleted: number;
  tasksCompleted: number;
  studyTimeSeconds: number;
  studyTimeLabel: string;
  quizAvg: number;
  quizzesTaken: number;
  quizzes90: number;
  projectsCompleted: number;
  achievementCount: number;
  achievements: { key: string; name: string; desc: string; tone: string; date: string }[];
  studyByDay: { day: string; hours: number }[];
  /** Consecutive days ending today with at least one study session. */
  streakDays: number;
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/** Builds the study-time chart for the last 7 calendar days (oldest → today). */
async function studyByDay(uid: Types.ObjectId): Promise<UserStats["studyByDay"]> {
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  const agg = await StudySessionModel.aggregate<{ _id: string; seconds: number }>([
    { $match: { userId: uid, day: { $in: days } } },
    { $group: { _id: "$day", seconds: { $sum: "$seconds" } } },
  ]);
  const secondsByDay = new Map(agg.map((a) => [a._id, a.seconds]));

  return days.map((day) => {
    const secs = secondsByDay.get(day) ?? 0;
    const label = new Date(`${day}T00:00:00`).toLocaleDateString("en-US", { weekday: "short" });
    return { day: label, hours: Number((secs / 3600).toFixed(2)) };
  });
}

/**
 * How many days in a row the student has studied, counting back from today.
 *
 * Walks UTC days because that is what `day` is bucketed by (progress.service's
 * today() uses toISOString) — deriving the cursor any other way would drop or
 * double a day for anyone not on UTC.
 *
 * Today not being in the set does NOT end the streak: a student who studied
 * yesterday and hasn't opened the app yet today still has one. It only breaks
 * once a whole day has passed with nothing logged, which is why the cursor is
 * allowed to start one day back.
 */
async function studyStreak(uid: Types.ObjectId): Promise<number> {
  const days: string[] = await StudySessionModel.distinct("day", { userId: uid });
  if (days.length === 0) return 0;
  const logged = new Set(days);

  const cursor = new Date();
  const key = () => cursor.toISOString().slice(0, 10);
  if (!logged.has(key())) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    if (!logged.has(key())) return 0;
  }

  let streak = 0;
  while (logged.has(key())) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

export async function getStats(userId: string): Promise<UserStats> {
  const uid = new Types.ObjectId(userId);
  const [counts, achievements, chart, streakDays] = await Promise.all([
    getProgressCounts(userId),
    AchievementModel.find({ userId: uid }).sort({ awardedAt: -1 }).lean(),
    studyByDay(uid),
    studyStreak(uid),
  ]);

  return {
    coursesEnrolled: counts.coursesEnrolled,
    lessonsCompleted: counts.lessonsCompleted,
    tasksCompleted: counts.tasksCompleted,
    studyTimeSeconds: counts.studyTimeSeconds,
    studyTimeLabel: formatDuration(counts.studyTimeSeconds),
    quizAvg: counts.quizAvg,
    quizzesTaken: counts.quizzesTaken,
    quizzes90: counts.quizzes90,
    projectsCompleted: counts.projectsCompleted,
    achievementCount: achievements.length,
    achievements: achievements.map((a) => ({
      key: a.key,
      name: a.name,
      desc: a.desc,
      tone: a.tone ?? "purple",
      date: (a.awardedAt ?? a.createdAt ?? new Date()).toISOString(),
    })),
    studyByDay: chart,
    streakDays,
  };
}
