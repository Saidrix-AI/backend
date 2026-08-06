# Functional Profile + Progress Tracking — Saidrix AI Tutor

Date: 2026-07-15
Status: Approved, implementing (phased)

## Goal

Make `/account/profile` fully functional (editable info + avatar upload, saved to a
real user schema) AND make the performance stats real by building progress-tracking
backends (enrollment, lesson completion, study time, quizzes, achievements).

## Decisions (approved)

- Avatar: base64 data URL stored on the user doc, size-capped (~300KB after client resize).
- Email + username: read-only (not editable). Editable: full name, phone, DOB, country, timezone, language, bio, avatar.
- Stats: **real data** — build tracking systems now (not placeholders).

## Data model

### User (extend existing)
Add: `phone?`, `dateOfBirth?` (Date), `country?`, `timezone?`, `language?`, `bio?`,
`avatar?` (base64 string), `role` (default `"Learner"`). Keep name/username/email/passwordHash/emailVerified.

### Enrollment (new) — one per user per course
`userId`, `courseId` (string, matches frontend coursesData id), `enrolledAt`,
`completedLessonIds: string[]`, `lastAccessedAt`. Unique (userId, courseId).

### QuizAttempt (new)
`userId`, `quizId`, `courseId?`, `score` (0-100), `createdAt`.

### StudySession (new) — append-only time log
`userId`, `seconds`, `day` (YYYY-MM-DD), `createdAt`. Aggregated for total + per-day chart.

### Achievement (new) — awarded, one per (userId, key)
`userId`, `key`, `name`, `desc`, `awardedAt`. Written by an evaluator after progress events.

### Tasks Completed
Derived from existing `RoutineItem` (count where done/completed). No new model.

## Endpoints
- `GET /api/user/profile` — full profile (incl avatar).
- `PATCH /api/user/profile` — update editable fields only (server ignores email/username).
- `PUT /api/user/avatar` — set/replace avatar (base64, size-validated).
- `GET /api/user/stats` — aggregated: coursesEnrolled, lessonsCompleted, studyTimeSeconds, tasksCompleted, quizAvg, achievements[], studyByDay[].
- `POST /api/progress/enroll` — `{ courseId }`.
- `POST /api/progress/complete-lesson` — `{ courseId, lessonId }`.
- `POST /api/progress/quiz` — `{ quizId, courseId?, score }`.
- `POST /api/progress/study-time` — `{ seconds }` (heartbeat from classroom).
All `requireAuth`.

## Achievements evaluator
After each progress event, run `evaluateAchievements(userId)`: checks progress and awards
(idempotent) achievements — e.g. `first_course` (1 enroll), `ai_explorer` (3 courses),
`quiz_master` (5 quizzes ≥90%), `consistent_learner` (study 7 distinct days).

## Frontend
- `lib/user.js` + `lib/progress.js` API clients (via shared `http.js`).
- Profile.jsx: fetch profile + stats, render real; edit modal (locked fields disabled);
  avatar picker (resize to ≤300KB via canvas, then PUT).
- Courses/CourseDetails: Enroll button → enroll; show enrolled state.
- Classroom: mark-lesson-complete, quiz submit → POST score, study-time heartbeat.

## Phases
1. User schema + profile backend + Profile page functional (edit + avatar). ← core
2. Progress backend (models + endpoints + stats aggregation + achievements evaluator).
3. Wire frontend content pages to emit events (enroll / complete-lesson / quiz / study-time).
4. Profile shows real stats; E2E verify.

## Verification
Per phase: typecheck + tests + browser E2E. Profile edit persists across reload;
avatar shows; enroll/complete/quiz/study reflect in `/api/user/stats` and on the profile.
