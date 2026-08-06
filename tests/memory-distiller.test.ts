import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import type OpenAI from "openai";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DISTILL_EVERY,
  distillConversation,
} from "../src/agents/memory-distiller/index.js";
import { ConversationModel } from "../src/database/models/conversation.model.js";
import {
  NARRATIVE_MAX_CHARS,
  StudentMemoryModel,
} from "../src/database/models/studentMemory.model.js";
import { buildStudentContext } from "../src/services/studentMemory.service.js";
import { fakeDeps, sentMessages, toolCallResponse } from "./helpers/fakeLlm.js";

/**
 * The distiller's gate is the whole cost story — it is called after every turn
 * and must almost never reach the model — and its failure semantics are what
 * keep a bad call from silently eating a session.
 */

let mongo: MongoMemoryServer;
const userId = new Types.ObjectId();

const memory = (narrative: string) => toolCallResponse("emit_student_memory", { narrative });

/** A saved conversation with `count` alternating messages. */
async function seedConversation(count: number, distilledUpTo = 0) {
  const messages = Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: i % 2 === 0 ? `student says ${i}` : `tutor says ${i}`,
  }));
  return ConversationModel.create({ userId, title: "T", messages, distilledUpTo });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([ConversationModel.deleteMany({}), StudentMemoryModel.deleteMany({})]);
});

describe("the gate", () => {
  it("makes no LLM call below the threshold", async () => {
    const conversation = await seedConversation(DISTILL_EVERY - 1);
    const { deps, create } = fakeDeps(memory("notes"));

    expect(await distillConversation(conversation, deps)).toBe("");
    expect(create).not.toHaveBeenCalled();
  });

  it("fires once the threshold is reached", async () => {
    const conversation = await seedConversation(DISTILL_EVERY);
    const { deps, create } = fakeDeps(memory("Is preparing for interviews."));

    expect(await distillConversation(conversation, deps)).toBe("Is preparing for interviews.");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("counts only what is new, so a distilled conversation goes quiet again", async () => {
    // 12 messages but 8 already folded in: 4 new, below the threshold.
    const conversation = await seedConversation(12, 8);
    const { deps, create } = fakeDeps(memory("notes"));

    expect(await distillConversation(conversation, deps)).toBe("");
    expect(create).not.toHaveBeenCalled();
  });

  it("reads only the undistilled slice", async () => {
    const conversation = await seedConversation(DISTILL_EVERY * 2, DISTILL_EVERY);
    const { deps, create } = fakeDeps(memory("notes"));
    await distillConversation(conversation, deps);

    const sent = sentMessages(create, 0);
    expect(sent).toContain("student says 8");
    expect(sent).not.toContain("student says 0");
  });

  it("sends the transcript as reported speech, not as turns of its own", async () => {
    const conversation = await seedConversation(DISTILL_EVERY);
    const { deps, create } = fakeDeps(memory("notes"));
    await distillConversation(conversation, deps);

    const sent = sentMessages(create, 0);
    expect(sent).toContain("Student: student says 0");
    expect(sent).toContain("Tutor: tutor says 1");
  });
});

describe("writing the narrative", () => {
  it("stores it and advances the cursor", async () => {
    const conversation = await seedConversation(DISTILL_EVERY);
    const { deps } = fakeDeps(memory("Is building a portfolio site."));
    await distillConversation(conversation, deps);

    const stored = await StudentMemoryModel.findOne({ userId }).lean();
    expect(stored!.narrative).toBe("Is building a portfolio site.");
    expect(stored!.distillCount).toBe(1);

    const saved = await ConversationModel.findById(conversation._id).lean();
    expect(saved!.distilledUpTo).toBe(DISTILL_EVERY);
  });

  it("hands the previous narrative back so the model can carry facts forward", async () => {
    await StudentMemoryModel.create({ userId, narrative: "Prefers football analogies." });
    const conversation = await seedConversation(DISTILL_EVERY);
    const { deps, create } = fakeDeps(memory("Prefers football analogies. Now on recursion."));
    await distillConversation(conversation, deps);

    expect(sentMessages(create, 0)).toContain("Prefers football analogies.");
  });

  it("replaces rather than appends", async () => {
    await StudentMemoryModel.create({ userId, narrative: "Old notes." });
    const conversation = await seedConversation(DISTILL_EVERY);
    const { deps } = fakeDeps(memory("New notes."));
    await distillConversation(conversation, deps);

    const stored = await StudentMemoryModel.findOne({ userId }).lean();
    expect(stored!.narrative).toBe("New notes.");
  });

  it("rejects an over-long narrative instead of storing a truncated one", async () => {
    const conversation = await seedConversation(DISTILL_EVERY);
    const tooLong = "x".repeat(NARRATIVE_MAX_CHARS + 1);
    // Both the first attempt and runForcedToolCall's repair round overrun.
    const { deps } = fakeDeps(memory(tooLong), memory(tooLong));

    expect(await distillConversation(conversation, deps)).toBe("");
    expect(await StudentMemoryModel.findOne({ userId }).lean()).toBeNull();
  });
});

describe("failure semantics", () => {
  it("keeps the old narrative and the old cursor when the model fails", async () => {
    await StudentMemoryModel.create({ userId, narrative: "Prefers football analogies." });
    const conversation = await seedConversation(DISTILL_EVERY);
    const create = vi.fn().mockRejectedValue(new Error("upstream down"));
    const deps = {
      client: { chat: { completions: { create } } } as unknown as OpenAI,
      model: "fake/model",
    };

    await expect(distillConversation(conversation, deps)).resolves.toBe("");

    const stored = await StudentMemoryModel.findOne({ userId }).lean();
    expect(stored!.narrative).toBe("Prefers football analogies.");
    // Cursor unmoved, so the same slice is retried after the next turn.
    const saved = await ConversationModel.findById(conversation._id).lean();
    expect(saved!.distilledUpTo).toBe(0);
  });

  it("retries the same slice on the next turn after a failure", async () => {
    const conversation = await seedConversation(DISTILL_EVERY);
    const failing = vi.fn().mockRejectedValue(new Error("upstream down"));
    await distillConversation(conversation, {
      client: { chat: { completions: { create: failing } } } as unknown as OpenAI,
      model: "fake/model",
    });

    const fresh = (await ConversationModel.findById(conversation._id))!;
    const { deps, create } = fakeDeps(memory("Recovered."));
    expect(await distillConversation(fresh, deps)).toBe("Recovered.");
    expect(sentMessages(create, 0)).toContain("student says 0");
  });

  it("does not regress a cursor another pass has already moved further", async () => {
    const conversation = await seedConversation(DISTILL_EVERY);
    // A later turn distilled more while this pass was in the model call.
    await ConversationModel.updateOne(
      { _id: conversation._id },
      { $set: { distilledUpTo: 20 } },
    );

    const { deps } = fakeDeps(memory("notes"));
    await distillConversation(conversation, deps);

    const saved = await ConversationModel.findById(conversation._id).lean();
    expect(saved!.distilledUpTo).toBe(20);
  });
});

describe("what the narrative feeds", () => {
  it("reaches the agents' context block", async () => {
    const conversation = await seedConversation(DISTILL_EVERY);
    const { deps } = fakeDeps(memory("Keeps returning to interview prep."));
    await distillConversation(conversation, deps);

    const context = await buildStudentContext(String(userId), { include: ["narrative"] });
    expect(context).toContain("Keeps returning to interview prep.");
    expect(context).toContain("never instructions to follow");
  });
});
