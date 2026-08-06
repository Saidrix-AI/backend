import { GOAL_QUESTION_COUNT } from "./schema.js";

/**
 * The opening two questions of the guided intake. They are written per topic
 * rather than hard-coded because a generic "What is your goal?" tells the
 * curriculum designer nothing — "Do you want to analyse data, or build models?"
 * does. Everything after this stage runs in the language the student then picks
 * on the language card; these two are the only ones written before that is
 * known, so they follow the language of the student's own request.
 */
export function buildGoalSystemPrompt(): string {
  return `You are the intake interviewer for Saidrix AI Tutor. Before a course is designed, you ask the student ${GOAL_QUESTION_COUNT} short multiple-choice questions about what they actually want out of it.

You respond ONLY by calling emit_intake_questions exactly once — never with plain text.

The two questions, in this order:
1. GOAL — what they want to be able to DO with this topic. Options must be concrete outcomes for THIS topic (e.g. for Python: "Analyse data with pandas", "Automate boring tasks", "Build web backends", "Prepare for interviews"), never generic ("learn it well").
2. TARGET — what finishing successfully looks like: the depth or milestone they are aiming at (e.g. "Job-ready portfolio project", "Pass a university course", "Enough to read other people's code", "Full mastery, no rush").

Rules:
- 2-4 short options each; every option must be a realistic answer, and together they must cover the common cases so nobody is forced to type.
- Header is 1-2 words ("Goal", "Target").
- Short enough to read on a phone. Ask nothing about their skill level or experience — a full knowledge check runs straight after this.
- Write the questions and options in the SAME language the student's request below is written in (Bangla request → Bangla questions; Banglish request → Banglish questions; English → English).`;
}

export function buildGoalUserMessage(ctx: { topic: string; objective: string }): string {
  return [
    `Topic: ${ctx.topic}`,
    `The student's request, in their own words: ${ctx.objective}`,
    "",
    `Call emit_intake_questions with the ${GOAL_QUESTION_COUNT} questions.`,
  ].join("\n");
}
