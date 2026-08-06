import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import {
  EXTRACTABLE_FIELDS,
  LearnerProfileModel,
} from "../src/database/models/learnerProfile.model.js";
import { UserModel } from "../src/database/models/user.model.js";
import {
  ageBandFromDob,
  buildLearnerContext,
  emptyLearnerFields,
  getLearnerProfile,
  renderLearnerContext,
  upsertLearnerProfile,
} from "../src/services/learnerProfile.service.js";

let mongo: MongoMemoryServer;
let userId: string;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const reg = await request(app).post("/api/auth/register").send({
    name: "Context User",
    username: "contextuser",
    email: "context@example.com",
    password: "supersecret123",
  });
  userId = reg.body.data.user.id ?? reg.body.data.user._id;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await LearnerProfileModel.deleteMany({});
  await UserModel.findByIdAndUpdate(userId, { dateOfBirth: null });
});

describe("renderLearnerContext", () => {
  it("returns an empty string for a missing profile", () => {
    expect(renderLearnerContext(null)).toBe("");
  });

  it("returns an empty string for a profile with nothing filled in", () => {
    expect(renderLearnerContext({ ageBand: "", occupation: "", learningInterests: [] })).toBe("");
  });

  it("emits only the lines that are actually filled", () => {
    const out = renderLearnerContext({ ageBand: "25-34", careerGoal: "Become a platform engineer" });
    expect(out).toContain("Age group: 25-34");
    expect(out).toContain("Career goal: Become a platform engineer");
    expect(out).not.toContain("Education:");
    expect(out).not.toContain("Work:");
    expect(out).not.toContain("Available:");
  });

  it("tells the model not to recite the block back", () => {
    const out = renderLearnerContext({ ageBand: "25-34" });
    expect(out).toContain("never mention it back to them");
  });

  it("collapses education and work into one line each", () => {
    const out = renderLearnerContext({
      educationLevel: "undergrad",
      educationDetail: "3rd year CSE",
      fieldOfStudy: "Computer Science",
      roleTitle: "Backend Engineer",
      industry: "Fintech",
      experienceYears: 4,
    });
    expect(out).toContain("Education: Undergraduate — 3rd year CSE, studying Computer Science");
    expect(out).toContain("Work: Backend Engineer, in Fintech, 4 years of experience");
  });

  it("singularises a single year of experience", () => {
    expect(renderLearnerContext({ experienceYears: 1 })).toContain("1 year of experience");
  });

  it("keeps zero as a real answer rather than treating it as unset", () => {
    expect(renderLearnerContext({ experienceYears: 0 })).toContain("0 years of experience");
  });

  it("omit suppresses the keys the assessment profile already owns", () => {
    const profile = {
      ageBand: "25-34",
      weeklyHours: 6,
      careerGoal: "Get job-ready",
      preferredStyle: "Worked examples",
    };
    const out = renderLearnerContext(profile, {
      omit: ["weeklyHours", "careerGoal", "preferredStyle"],
    });
    expect(out).toContain("Age group: 25-34");
    expect(out).not.toContain("Available:");
    expect(out).not.toContain("Career goal:");
    expect(out).not.toContain("Learns best:");
  });

  it("returns an empty string when omit removes everything that was filled", () => {
    expect(renderLearnerContext({ weeklyHours: 6 }, { omit: ["weeklyHours"] })).toBe("");
  });
});

describe("ageBandFromDob", () => {
  it("returns an empty string with no date of birth", () => {
    expect(ageBandFromDob(null)).toBe("");
    expect(ageBandFromDob(undefined)).toBe("");
  });

  it("buckets an age into the right band", () => {
    const yearsAgo = (n: number) => new Date(Date.now() - n * 365.2425 * 24 * 60 * 60 * 1000);
    expect(ageBandFromDob(yearsAgo(15))).toBe("under-18");
    expect(ageBandFromDob(yearsAgo(21))).toBe("18-24");
    expect(ageBandFromDob(yearsAgo(30))).toBe("25-34");
    expect(ageBandFromDob(yearsAgo(40))).toBe("35-44");
    expect(ageBandFromDob(yearsAgo(50))).toBe("45-plus");
  });
});

describe("emptyLearnerFields", () => {
  it("reports every extractable key for a user with no profile", () => {
    // Against the constant, not a number: EXTRACTABLE_FIELDS is a deliberate
    // subset of LEARNER_FIELDS and both are expected to grow.
    expect(emptyLearnerFields(null)).toEqual([...EXTRACTABLE_FIELDS]);
  });

  it("never offers the keys a model would have to invent", () => {
    const all = emptyLearnerFields(null);
    for (const field of ["institutionName", "companyName", "studyStartYear", "selfRatedLevel"]) {
      expect(all).not.toContain(field);
    }
  });

  it("drops keys once they are filled, and treats [] and null as empty", () => {
    const empty = emptyLearnerFields({
      ageBand: "25-34",
      experienceYears: 0,
      learningInterests: [],
      weeklyHours: null,
    });
    expect(empty).not.toContain("ageBand");
    expect(empty).not.toContain("experienceYears");
    expect(empty).toContain("learningInterests");
    expect(empty).toContain("weeklyHours");
  });
});

describe("buildLearnerContext", () => {
  it("returns an empty string when the user has no profile at all", async () => {
    expect(await buildLearnerContext(userId)).toBe("");
  });

  it("derives the age band from the account's date of birth", async () => {
    await UserModel.findByIdAndUpdate(userId, {
      dateOfBirth: new Date(Date.now() - 30 * 365.2425 * 24 * 60 * 60 * 1000),
    });
    await upsertLearnerProfile(userId, { occupation: "job" }, "wizard");
    const out = await buildLearnerContext(userId);
    expect(out).toContain("Age group: 25-34");
    expect(out).toContain("Currently: working a job");
  });

  it("prefers the answered age band over the derived one", async () => {
    await UserModel.findByIdAndUpdate(userId, {
      dateOfBirth: new Date(Date.now() - 30 * 365.2425 * 24 * 60 * 60 * 1000),
    });
    await upsertLearnerProfile(userId, { ageBand: "45-plus" }, "wizard");
    expect(await buildLearnerContext(userId)).toContain("Age group: 45 or older");
  });

  it("returns an empty string instead of throwing on a malformed user id", async () => {
    expect(await buildLearnerContext("not-an-object-id")).toBe("");
  });
});

describe("upsertLearnerProfile", () => {
  it("creates the profile on first write and records provenance", async () => {
    await upsertLearnerProfile(userId, { occupation: "student" }, "wizard");
    const doc = await LearnerProfileModel.findOne({ userId });
    expect(doc!.occupation).toBe("student");
    expect(doc!.sources.get("occupation")).toBe("wizard");
  });

  it("ignores empty values rather than clearing a field", async () => {
    await upsertLearnerProfile(userId, { roleTitle: "Backend Engineer" }, "wizard");
    await upsertLearnerProfile(userId, { roleTitle: "" }, "wizard");
    const doc = await getLearnerProfile(userId);
    expect(doc!.roleTitle).toBe("Backend Engineer");
  });

  it("clears a field when the profile page explicitly asks to", async () => {
    await upsertLearnerProfile(userId, { roleTitle: "Backend Engineer" }, "wizard");
    await upsertLearnerProfile(userId, { roleTitle: "" }, "profile", { allowClear: true });
    const doc = await getLearnerProfile(userId);
    expect(doc!.roleTitle).toBe("");
  });

  it("never lets a chat inference overwrite a wizard or profile answer", async () => {
    await upsertLearnerProfile(userId, { occupation: "student" }, "wizard");
    await upsertLearnerProfile(userId, { industry: "Fintech" }, "profile");

    await upsertLearnerProfile(userId, { occupation: "job", industry: "Retail" }, "chat");

    const doc = await getLearnerProfile(userId);
    expect(doc!.occupation).toBe("student");
    expect(doc!.industry).toBe("Fintech");
  });

  it("lets a chat inference fill an empty key, and refine its own earlier guess", async () => {
    await upsertLearnerProfile(userId, { fieldOfStudy: "CS" }, "chat");
    expect((await getLearnerProfile(userId))!.fieldOfStudy).toBe("CS");

    await upsertLearnerProfile(userId, { fieldOfStudy: "Computer Science" }, "chat");
    expect((await getLearnerProfile(userId))!.fieldOfStudy).toBe("Computer Science");
  });

  it("lets the wizard and the profile page overwrite a chat guess", async () => {
    await upsertLearnerProfile(userId, { roleTitle: "Dev" }, "chat");
    await upsertLearnerProfile(userId, { roleTitle: "Backend Engineer" }, "profile");
    const doc = await getLearnerProfile(userId);
    expect(doc!.roleTitle).toBe("Backend Engineer");
    expect(doc!.sources).toBeTruthy();
  });
});
