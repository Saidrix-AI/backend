import { Schema, model, type InferSchemaType } from "mongoose";

const sourceSchema = new Schema(
  {
    title: { type: String, required: true },
    url: { type: String, required: true },
  },
  { _id: false },
);

const attachmentSchema = new Schema(
  {
    name: { type: String, required: true },
    mimeType: { type: String, required: true },
    kind: { type: String, enum: ["image", "text"], required: true },
    // Only images keep their data (small, base64) so they can be re-rendered
    // as a thumbnail when a conversation is reloaded. Text-file content is
    // used for that turn's model context only and isn't persisted.
    dataUrl: { type: String },
  },
  { _id: false },
);

// A tool action the agent performed during this turn (e.g. "Course X created"),
// kept so activity chips can be re-rendered when a conversation is reloaded.
const actionSchema = new Schema(
  {
    name: { type: String, required: true },
    label: { type: String, required: true },
    ok: { type: Boolean, required: true },
    changed: { type: String },
  },
  { _id: false },
);

// A multi-course proposal shown in this turn as selectable cards, kept so the
// cards can be re-rendered (and re-selected if still newest) when a
// conversation is reloaded.
const proposedCourseSchema = new Schema(
  {
    title: { type: String, required: true },
    objective: { type: String, required: true },
    level: { type: String },
    note: { type: String },
  },
  { _id: false },
);

// A batch of interactive MCQ questions from ask_questions, kept so the cards
// can be re-rendered (and re-answered if still newest) when reloaded.
const askQuestionSchema = new Schema(
  {
    question: { type: String, required: true },
    header: { type: String, required: true },
    options: { type: [String], required: true },
    multiSelect: { type: Boolean },
  },
  { _id: false },
);

// The opening round of a knowledge check started in this turn, kept so the
// cards can be re-rendered (and resumed if still newest) after a reload. The
// remaining rounds live on the assessment document itself.
const assessmentStartSchema = new Schema(
  {
    assessmentId: { type: String, required: true },
    round: { type: Number, required: true },
    totalRounds: { type: Number, required: true },
    answered: { type: Number, default: 0 },
    totalQuestions: { type: Number, required: true },
    questions: { type: [askQuestionSchema], required: true },
  },
  { _id: false },
);

// The opening stage of a guided intake started in this turn, kept so the cards
// can be re-rendered (and resumed if still newest) after a reload. The rest of
// the stage machine lives on the intake document itself.
const intakeStartSchema = new Schema(
  {
    intakeId: { type: String, required: true },
    stage: { type: String, required: true },
    stageIndex: { type: Number, required: true },
    totalStages: { type: Number, required: true },
    stageLabel: { type: String, required: true },
    questions: { type: [askQuestionSchema], required: true },
    round: { type: Number },
    totalRounds: { type: Number },
    answered: { type: Number },
    totalQuestions: { type: Number },
  },
  { _id: false },
);

const messageSchema = new Schema(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true },
    reasoning: { type: String },
    sources: { type: [sourceSchema], default: undefined },
    attachments: { type: [attachmentSchema], default: undefined },
    actions: { type: [actionSchema], default: undefined },
    proposal: { type: [proposedCourseSchema], default: undefined },
    questions: { type: [askQuestionSchema], default: undefined },
    assessment: { type: assessmentStartSchema, default: undefined },
    intake: { type: intakeStartSchema, default: undefined },
    agent: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const conversationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String },
    messages: { type: [messageSchema], default: [] },
    // How far into `messages` the student-memory distiller has already read.
    // Advanced only after a successful rewrite, so a failed pass simply retries
    // the same slice next turn instead of losing it. See
    // agents/memory-distiller and StudentMemory.
    distilledUpTo: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

export type Conversation = InferSchemaType<typeof conversationSchema>;
export const ConversationModel = model("Conversation", conversationSchema);
