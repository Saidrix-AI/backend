/**
 * Read-side views of a stored lecture (v3: `sections`).
 *
 * The document stores sections only. The classroom renders blocks grouped by
 * section, and the voice agent walks the teaching spine, so both are derived
 * here instead of being stored twice:
 *
 *  - `blocks`: every section's blocks in order, each tagged with its section
 *    (`sectionId`, mirrored as `beatId` for the renderer's grouping).
 *  - `beats`: one per taught section, in the shape the live tutor reads — the
 *    section's tutor instructions plus `kind` and the block it demonstrates.
 *
 * The student view never carries `tutor`: its rubrics are what the tutor
 * judges spoken answers against, and its explanation points are what the tutor
 * says — neither is page content.
 */

type Block = { id?: string; type?: string; questions?: QuizQuestion[]; [k: string]: unknown };

interface QuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation?: string;
  concept?: string;
}

export interface StoredSection {
  id: string;
  topicId: number;
  title: string;
  kind: "theory" | "practical" | "canvas";
  blocks: Block[];
  tutor?: {
    goal: string;
    explain: string[];
    deeper?: string[];
    analogy?: string;
    misconceptions?: { mistake: string; whatBreaks: string; correction: string }[];
    ask?: { question: string; expectedPoints: string[]; worth?: "ask" | "skip" };
    check: { mustShow: string; mode?: "verbal" | "code"; weight?: "key" | "light" };
    demo?: string;
  };
}

/** The quiz answer key never leaves the server, for either audience. */
export function stripQuizAnswers(blocks: Block[]): Block[] {
  return blocks.map((b) => {
    if (b?.type !== "quiz" || !Array.isArray(b.questions)) return b;
    return {
      ...b,
      questions: b.questions.map(({ correctIndex: _c, explanation: _e, concept: _k, ...rest }) => rest as QuizQuestion),
    };
  });
}

export function flattenBlocks(sections: StoredSection[]): Block[] {
  return sections.flatMap((s) => s.blocks.map((b) => ({ ...b, sectionId: s.id, beatId: s.id, topicId: s.topicId })));
}

/** The block a practical/canvas section demonstrates: its code, or its diagram. */
function demoFor(s: StoredSection): { kind: "code" | "draw"; blockId: string } | null {
  if (s.kind === "practical") {
    const code = s.blocks.find((b) => b.type === "code");
    return code?.id ? { kind: "code", blockId: code.id } : null;
  }
  if (s.kind === "canvas") {
    const drawing = s.blocks.find((b) => b.type === "mermaid" || b.type === "tree");
    return drawing?.id ? { kind: "draw", blockId: drawing.id } : null;
  }
  return null;
}

/** The teaching spine the voice agent walks: one beat per section that has tutor instructions. */
export function sectionsToBeats(sections: StoredSection[]) {
  return sections
    .filter((s) => s.tutor)
    .map((s) => {
      const t = s.tutor!;
      return {
        id: s.id,
        topicId: s.topicId,
        concept: s.title,
        kind: s.kind,
        objective: t.goal,
        probe: {
          ask: t.ask?.question ?? s.title,
          expectedPoints: t.ask?.expectedPoints?.length ? t.ask.expectedPoints : [t.goal],
          worth: t.ask?.worth ?? "skip",
        },
        teach: {
          plain: { points: t.explain, ...(t.analogy ? { analogy: t.analogy } : {}) },
          deeper: { points: t.deeper ?? [] },
          misconceptions: t.misconceptions ?? [],
        },
        blockIds: s.blocks.map((b) => b.id).filter((id): id is string => typeof id === "string"),
        demo: demoFor(s),
        demoBrief: t.demo ?? null,
        checkpoint: { mustShow: t.check.mustShow, mode: t.check.mode ?? "verbal", weight: t.check.weight ?? "light" },
      };
    });
}

export type LectureAudience = "student" | "tutor";

export interface LectureDocShape {
  lessonId: string;
  version?: number;
  language?: string;
  kind?: string;
  course?: { title?: string; breadcrumb?: string[] };
  title: string;
  outline?: unknown[];
  sections?: StoredSection[];
}

/** The lecture JSON both the Classroom and the voice agent consume. */
export function toLectureJson(doc: LectureDocShape, audience: LectureAudience = "student") {
  const sections = doc.sections ?? [];
  const forReader = sections.map((s) => ({
    id: s.id,
    topicId: s.topicId,
    title: s.title,
    kind: s.kind,
    blocks: stripQuizAnswers(s.blocks),
    ...(audience === "tutor" && s.tutor ? { tutor: s.tutor } : {}),
  }));
  const beats = sectionsToBeats(sections);
  return {
    id: doc.lessonId,
    version: doc.version,
    language: doc.language,
    kind: doc.kind ?? "concept",
    course: doc.course,
    title: doc.title,
    outline: doc.outline,
    sections: forReader,
    blocks: stripQuizAnswers(flattenBlocks(sections)),
    beats:
      audience === "tutor"
        ? beats
        : beats.map((b) => ({ id: b.id, topicId: b.topicId, concept: b.concept, kind: b.kind })),
  };
}
export type LectureJson = ReturnType<typeof toLectureJson>;

/** The stored quiz (with its key) — read only by grading. */
export function findQuiz(doc: LectureDocShape): QuizQuestion[] | undefined {
  for (const s of doc.sections ?? []) {
    const quiz = s.blocks.find((b) => b.type === "quiz");
    if (quiz && Array.isArray(quiz.questions)) return quiz.questions;
  }
  return undefined;
}
