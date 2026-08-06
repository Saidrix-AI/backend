import type OpenAI from "openai";
import { LANGUAGE_LABELS, type Language } from "../../../validation/language.js";
import type { AskQuestion } from "../types.js";

/**
 * The guided intake as the chat model sees it. The stages themselves are run by
 * the server (services/intake.service.ts) — this file only holds the tool the
 * model calls to start one, plus the constants both the service and the chat
 * router match on. See ../intake-tools.ts for the implementation.
 */

export const startLearningIntakeTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "start_learning_intake",
    description:
      "Start the guided setup that comes before ANY course is built: goal & target, the language the course should be written in, an adaptive ~16-question knowledge check, and their study timetable — all shown as interactive cards, one question at a time. Call this INSTEAD of asking about their goal, level, language or schedule in text or with ask_questions. The student answers in the cards and their full profile comes back to you in a later message — do NOT call generate_course or propose_courses in the same turn.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The subject to be learned, e.g. 'Python for data analysis'" },
        objective: {
          type: "string",
          description: "What the student said they want to learn and why, in their own words",
        },
        scope: {
          type: "string",
          enum: ["single", "multi"],
          description:
            "single when they named one topic; multi for a broad career/path goal that will need several courses",
        },
      },
      required: ["topic", "objective"],
    },
  },
};

/** Tool message after stage 1 is on screen — the turn must end here. */
export function intakeStartedText(stageLabel: string, totalStages: number): string {
  return (
    `The guided intake is now running in the student's chat as interactive cards ` +
    `(stage 1 of ${totalStages}: ${stageLabel}). Do NOT restate the questions as text, do NOT ask ` +
    "anything else, and do NOT create any course yet. End your turn with one short line telling them to " +
    "answer the cards and that you will design their learning path from the answers."
  );
}

/**
 * Tool message when the student already answered the interview for this same
 * topic minutes ago: no cards are shown and the turn carries straight on to the
 * learning path, using what they already told us.
 */
export function intakeAlreadyDoneText(prior: {
  topic: string;
  language: Language;
  goal: string;
  timetable: string;
}): string {
  return (
    `No cards were shown — this student completed the guided setup for "${prior.topic}" a short while ago, ` +
    "so do NOT ask any of it again. Use these answers and go straight on to propose_courses in this same turn:\n" +
    `- Goal: ${prior.goal || "not stated"}\n` +
    `- Language for the course: ${LANGUAGE_LABELS[prior.language]} — write the whole path in it\n` +
    `- Study timetable: ${prior.timetable || "not stated"}`
  );
}

/**
 * Exact prefix the finished intake sends back as a user message. The chat
 * router matches it to force propose_courses, so the client (lib/intake.js)
 * must build the message with exactly this prefix.
 */
export const INTAKE_DONE_PREFIX = "Learning intake complete:";

/** The two stages the server writes itself rather than asking a model for. */
export const LANGUAGE_QUESTION: AskQuestion = {
  header: "Language",
  question: "Which language should your course, lessons and quizzes be written in?",
  options: [LANGUAGE_LABELS.en, LANGUAGE_LABELS.bn, LANGUAGE_LABELS["bn-latn"]],
};

/**
 * Asked before any course exists, because a course can legitimately contain a
 * lesson whose whole job is installing an editor or a runtime — and those
 * lessons are written for ONE operating system. Without this the guide has to
 * cover all three, and two thirds of it is noise for whoever is reading it.
 */
export const DEVICE_QUESTION: AskQuestion = {
  header: "Your computer",
  question: "Which computer will you be practising on? Setup lessons are written for it specifically.",
  options: ["Windows", "macOS", "Linux"],
};

/**
 * The chosen option (or whatever they typed instead) → the stored enum, or ""
 * when nothing recognisable came back. Free text is expected: the question dock
 * always offers its own "Other" box, and "mac", "ubuntu" and "win 11" are all
 * things a student types there.
 */
export function parseOperatingSystem(answer: string): "windows" | "macos" | "linux" | "" {
  const a = answer.toLowerCase();
  if (/\b(mac|macos|osx|os x|macbook|imac|apple)\b/.test(a)) return "macos";
  if (/\b(windows|win|win10|win11|pc)\b/.test(a)) return "windows";
  if (/\b(linux|ubuntu|debian|fedora|arch|mint|pop_os|popos|wsl)\b/.test(a)) return "linux";
  return "";
}
