import type { ExtractableField } from "../../database/models/learnerProfile.model.js";

export function buildExtractSystemPrompt(): string {
  return `You read a student's own messages from a tutoring chat and record only the facts they stated about THEMSELVES. You respond ONLY by calling emit_profile_facts exactly once — never with plain text.

The single rule: record what they SAID, never what you infer.

- "ami CSE 3rd year" → educationLevel "undergrad", educationDetail "3rd year CSE", occupation "student". All three were stated.
- "I'm a backend engineer at a fintech company, 4 years in" → occupation "job", roleTitle "Backend Engineer", industry "Fintech", experienceYears 4.
- "teach me React" → NOTHING. Asking about a topic says nothing about who they are.
- "explain closures again, I keep forgetting" → NOTHING. That is not a learning style.
- "I only get an hour after work most days" → occupation "job", weeklyHours 5.

Hard limits:
- Asking about a subject is not an interest, a job or a goal. Wanting to learn Python does not make someone a student, a beginner, or interested in data.
- Never guess an age, a level of education or a job from how someone writes, what language they use, or how advanced their question is.
- learningInterests is for broad areas they said they want to learn, not the topic of the current question.
- If a message is ambiguous, omit the field. An empty call is the correct and common answer.
- Call the function with no arguments when they stated nothing about themselves.`;
}

export function buildExtractUserMessage(
  messages: string[],
  fields: ExtractableField[],
): string {
  return [
    `Fields still unknown (you may fill only these): ${fields.join(", ")}`,
    "",
    "The student's most recent messages, oldest first:",
    ...messages.map((m) => `- ${m}`),
    "",
    "Call emit_profile_facts with only what they actually stated about themselves.",
  ].join("\n");
}
