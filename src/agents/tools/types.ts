import type OpenAI from "openai";
import type { ZodError } from "zod";
import type { SearchSource } from "./web-search.js";

/** Identity the tool executes as. DB tools are always scoped to this user. */
export interface ToolContext {
  userId: string;
}

/** One course in a propose_courses payload, rendered as a selectable card. */
export interface ProposedCourse {
  title: string;
  objective: string;
  level?: string;
  note?: string;
  /** 1-2 lines of what this course teaches — shown on the card and used for path scoping. */
  covers?: string;
}

/** One question in an ask_questions payload, rendered as an interactive MCQ card. */
export interface AskQuestion {
  question: string;
  header: string;
  options: string[];
  multiSelect?: boolean;
}

/**
 * The first round of a multi-round knowledge check. The client keeps stepping
 * through the same card UI, posting each round to /api/assessments and getting
 * the next one back — the chat turn ends here.
 */
export interface AssessmentStart {
  assessmentId: string;
  round: number;
  totalRounds: number;
  answered: number;
  totalQuestions: number;
  questions: AskQuestion[];
}

/**
 * The opening stage of a guided intake (goal → language → knowledge check →
 * timetable). Like the knowledge check, the client keeps stepping through the
 * same card UI — posting each stage to /api/intake — and the chat turn ends here.
 * Shape mirrors services/intake.service.ts IntakeStagePayload.
 */
export interface IntakeStart {
  intakeId: string;
  stage: string;
  stageIndex: number;
  totalStages: number;
  stageLabel: string;
  questions: AskQuestion[];
  round?: number;
  totalRounds?: number;
  answered?: number;
  totalQuestions?: number;
}

export interface ToolOutcome {
  ok: boolean;
  /** Completion label for the UI chip, e.g. `Course "React Basics" created`. */
  label: string;
  /** Text fed back to the model as the tool message. */
  modelText: string;
  /** Set when a write succeeded — which page's data changed. */
  changed?: "course" | "project" | "routine";
  /** web_search only. */
  sources?: SearchSource[];
  /** propose_courses only — structured payload for the selection-cards UI. */
  proposal?: ProposedCourse[];
  /** ask_questions only — structured payload for the interactive question cards. */
  questions?: AskQuestion[];
  /** start_knowledge_check only — the first round of a server-driven assessment. */
  assessment?: AssessmentStart;
  /** start_learning_intake only — the first stage of a server-driven intake. */
  intake?: IntakeStart;
}

export interface RegisteredTool {
  schema: OpenAI.Chat.ChatCompletionFunctionTool;
  /** Chip label while running; args are raw model JSON — be defensive. */
  runningLabel: (args: Record<string, unknown>) => string;
  /** MUST NOT throw — map every failure into an ok:false outcome. */
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolOutcome>;
}

/** Zod validation failure → tool message the model can self-correct from. */
export function invalidArgs(label: string, err: ZodError): ToolOutcome {
  const issues = err.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return {
    ok: false,
    label,
    modelText: `Invalid arguments: ${issues}. Fix the arguments and call the tool again.`,
  };
}

/** Runtime failure (ApiError etc.) → tool message, never a thrown error. */
export function failure(label: string, err: unknown): ToolOutcome {
  return {
    ok: false,
    label,
    modelText: err instanceof Error ? err.message : "Unexpected error while running the tool.",
  };
}
