import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import type { ChatOpenAI } from "@langchain/openai";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildExtractTool } from "../src/agents/profile-extractor/schema.js";
import { updateProfileFromChat } from "../src/agents/profile-extractor/index.js";
import { LearnerProfileModel } from "../src/database/models/learnerProfile.model.js";
import {
  buildLearnerContext,
  getLearnerProfile,
  upsertLearnerProfile,
} from "../src/services/learnerProfile.service.js";
import { fakeDeps, sentMessages, toolCallResponse } from "./helpers/fakeLlm.js";

let mongo: MongoMemoryServer;
const userId = new Types.ObjectId().toString();

const facts = (args: Record<string, unknown>) => toolCallResponse("emit_profile_facts", args);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await LearnerProfileModel.deleteMany({});
});

describe("the tool schema", () => {
  it("offers only the fields that are still missing", () => {
    const tool = buildExtractTool(["occupation", "industry"]);
    const props = tool.function.parameters!.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(["occupation", "industry"]);
  });

  it("requires nothing, so an empty call is valid", () => {
    const tool = buildExtractTool(["occupation"]);
    expect(tool.function.parameters!.required).toEqual([]);
  });
});

describe("gating", () => {
  it("makes no LLM call when every field is already filled", async () => {
    await upsertLearnerProfile(
      userId,
      {
        ageBand: "25-34",
        occupation: "job",
        operatingSystem: "linux",
        educationLevel: "undergrad",
        educationDetail: "3rd year",
        fieldOfStudy: "CSE",
        industry: "Fintech",
        roleTitle: "Backend Engineer",
        experienceYears: 4,
        learningInterests: ["Cloud & DevOps"],
        careerGoal: "Platform work",
        weeklyHours: 6,
        preferredStyle: "Worked examples",
        biggestBlocker: "Never enough time",
      },
      "wizard",
    );

    const { deps, create } = fakeDeps(facts({ industry: "Retail" }));
    const filled = await updateProfileFromChat(userId, ["ami akhon retail e kaj kori"], deps);

    expect(create).not.toHaveBeenCalled();
    expect(filled).toEqual([]);
  });

  it("makes no LLM call when the student has said nothing", async () => {
    const { deps, create } = fakeDeps(facts({}));
    await updateProfileFromChat(userId, ["", "   "], deps);
    expect(create).not.toHaveBeenCalled();
  });

  it("sends only the student's messages, never the assistant's", async () => {
    const { deps, create } = fakeDeps(facts({}));
    await updateProfileFromChat(userId, ["ami CSE 3rd year"], deps);
    const sent = sentMessages(create, 0);
    expect(sent).toContain("ami CSE 3rd year");
  });

  it("looks at only the last few messages", async () => {
    const { deps, create } = fakeDeps(facts({}));
    const many = Array.from({ length: 12 }, (_, i) => `message ${i}`);
    await updateProfileFromChat(userId, many, deps);
    const sent = sentMessages(create, 0);
    expect(sent).toContain("message 11");
    expect(sent).not.toContain("message 0");
  });
});

describe("writing what it found", () => {
  it("fills empty fields from a stated fact", async () => {
    const { deps } = fakeDeps(
      facts({ occupation: "student", educationLevel: "undergrad", educationDetail: "3rd year CSE" }),
    );
    const filled = await updateProfileFromChat(userId, ["ami CSE 3rd year"], deps);

    expect(filled.sort()).toEqual(["educationDetail", "educationLevel", "occupation"]);
    const profile = await getLearnerProfile(userId);
    expect(profile!.occupation).toBe("student");
    expect(profile!.educationDetail).toBe("3rd year CSE");
  });

  it("never overwrites a wizard answer", async () => {
    await upsertLearnerProfile(userId, { occupation: "student" }, "wizard");
    const { deps } = fakeDeps(facts({ occupation: "job", industry: "Fintech" }));
    await updateProfileFromChat(userId, ["I work at a fintech now"], deps);

    const profile = await getLearnerProfile(userId);
    expect(profile!.occupation).toBe("student");
    // The empty field beside it still gets filled.
    expect(profile!.industry).toBe("Fintech");
  });

  it("never overwrites an answer edited on the profile page", async () => {
    await upsertLearnerProfile(userId, { roleTitle: "Backend Engineer" }, "profile");
    const { deps } = fakeDeps(facts({ roleTitle: "Intern" }));
    await updateProfileFromChat(userId, ["I'm an intern"], deps);
    expect((await getLearnerProfile(userId))!.roleTitle).toBe("Backend Engineer");
  });

  it("ignores a key the model invented outside the missing set", async () => {
    await upsertLearnerProfile(userId, { industry: "Fintech" }, "wizard");
    const { deps } = fakeDeps(facts({ industry: "Retail", roleTitle: "Designer" }));
    await updateProfileFromChat(userId, ["I design things at a retail company"], deps);

    const profile = await getLearnerProfile(userId);
    expect(profile!.industry).toBe("Fintech");
    expect(profile!.roleTitle).toBe("Designer");
  });

  it("writes nothing when the student stated nothing about themselves", async () => {
    const { deps } = fakeDeps(facts({}));
    const filled = await updateProfileFromChat(userId, ["teach me React"], deps);
    expect(filled).toEqual([]);
    expect(await getLearnerProfile(userId)).toBeNull();
  });

  it("rejects a value outside the enum instead of storing it", async () => {
    const { deps } = fakeDeps(facts({ occupation: "astronaut" }), facts({}));
    const filled = await updateProfileFromChat(userId, ["I'm an astronaut"], deps);
    expect(filled).toEqual([]);
  });

  it("swallows an LLM failure rather than surfacing it", async () => {
    // Rejects on every attempt, including the repair round runForcedToolCall makes.
    const create = vi.fn().mockRejectedValue(new Error("upstream down"));
    const deps = {
      chat: { bindTools: () => ({ invoke: create }) } as unknown as ChatOpenAI,
      model: "fake/model",
    };
    await expect(updateProfileFromChat(userId, ["ami CSE 3rd year"], deps)).resolves.toEqual([]);
  });

  it("feeds what it learned straight into the agents' context block", async () => {
    const { deps } = fakeDeps(facts({ occupation: "job", roleTitle: "Backend Engineer" }));
    await updateProfileFromChat(userId, ["I'm a backend engineer"], deps);
    const context = await buildLearnerContext(userId);
    expect(context).toContain("Currently: working a job");
    expect(context).toContain("Work: Backend Engineer");
  });
});
