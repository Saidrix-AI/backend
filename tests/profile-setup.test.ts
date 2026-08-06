import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { LearnerProfileModel, YEAR_MAX } from "../src/database/models/learnerProfile.model.js";
import { UserModel } from "../src/database/models/user.model.js";
import {
  buildLearnerContext,
  emptyLearnerFields,
  getLearnerProfile,
  upsertLearnerProfile,
} from "../src/services/learnerProfile.service.js";
import { buildStudentContext } from "../src/services/studentMemory.service.js";

// The Finish-profile flow: the popup's own state machine, the fields it adds,
// and the two guarantees that make it safe to feed into prompts — the student's
// answers cannot be overwritten by the chat extractor, and the one field that is
// marketing data never reaches a prompt at all.

let mongo: MongoMemoryServer;

interface Account {
  token: string;
  id: string;
}

async function register(name: string): Promise<Account> {
  const res = await request(app).post("/api/auth/register").send({
    name,
    username: name,
    email: `${name}@example.com`,
    password: "supersecret123",
  });
  return { token: res.body.data.accessToken, id: res.body.data.user.id };
}

const auth = (a: Account) => ({ Authorization: `Bearer ${a.token}` });

const getProfile = (a: Account) => request(app).get("/api/user/profile").set(auth(a));
const patchProfile = (a: Account, body: object) =>
  request(app).patch("/api/user/profile").set(auth(a)).send(body);
const patchSetup = (a: Account, body: object) =>
  request(app).patch("/api/user/profile-setup").set(auth(a)).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("profile setup state", () => {
  it("starts pending, so an account that predates the feature is still offered it", async () => {
    const a = await register("setupfresh");
    const res = await getProfile(a);
    expect(res.body.data.profile.profileSetup).toMatchObject({
      step: 0,
      completedAt: null,
      skippedAt: null,
      pending: true,
    });
  });

  it("remembers the step so a half-finished popup resumes where it was", async () => {
    const a = await register("setupresume");
    await patchSetup(a, { step: 1 });
    const res = await getProfile(a);
    expect(res.body.data.profile.profileSetup.step).toBe(1);
    // Moving between steps is not finishing — the popup must still open.
    expect(res.body.data.profile.profileSetup.pending).toBe(true);
  });

  it("skipping stops the auto-popup without marking it done", async () => {
    const a = await register("setupskip");
    const res = await patchSetup(a, { status: "skipped" });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.profileSetup.skippedAt).not.toBeNull();
    expect(res.body.data.profile.profileSetup.completedAt).toBeNull();
    expect(res.body.data.profile.profileSetup.pending).toBe(false);
  });

  it("finishing after a skip clears the skip, so the banner goes away", async () => {
    const a = await register("setupfinish");
    await patchSetup(a, { status: "skipped" });
    const res = await patchSetup(a, { status: "completed" });
    expect(res.body.data.profile.profileSetup.completedAt).not.toBeNull();
    expect(res.body.data.profile.profileSetup.skippedAt).toBeNull();
    expect(res.body.data.profile.profileSetup.pending).toBe(false);
  });

  it("rejects a step outside the two the flow has", async () => {
    const a = await register("setupbadstep");
    expect((await patchSetup(a, { step: 7 })).status).toBe(400);
  });
});

describe("profile setup fields", () => {
  it("saves the step-1 student branch and reads it back", async () => {
    const a = await register("setupstudent");
    const res = await patchProfile(a, {
      address: "Mirpur, Dhaka",
      preferredLanguages: ["bn-latn", "en"],
      occupation: "student",
      operatingSystem: "windows",
      educationLevel: "undergrad",
      educationDetail: "3rd year",
      institutionName: "BUET",
      fieldOfStudy: "Computer Science",
      studyStartYear: 2022,
      studyEndYear: 2026,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.address).toBe("Mirpur, Dhaka");
    expect(res.body.data.profile.preferredLanguages).toEqual(["bn-latn", "en"]);
    expect(res.body.data.profile.learner).toMatchObject({
      institutionName: "BUET",
      studyStartYear: 2022,
      studyEndYear: 2026,
    });
  });

  it("saves the step-1 professional branch", async () => {
    const a = await register("setuppro");
    const res = await patchProfile(a, {
      occupation: "job",
      companyName: "Acme",
      roleTitle: "Backend Engineer",
      experienceYears: 4,
      roleSummary: "Owns the payments API and its on-call rotation.",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.learner).toMatchObject({
      companyName: "Acme",
      roleSummary: "Owns the payments API and its on-call rotation.",
    });
  });

  it("saves the step-2 answers", async () => {
    const a = await register("setupstep2");
    const res = await patchProfile(a, {
      industry: "Fintech",
      careerGoal: "Get my first job",
      biggestBlocker: "I never know where to start",
      preferredStyle: "Worked examples",
      selfRatedLevel: "basics",
      weeklyHours: 6,
      learningInterests: ["Web development"],
      referralSource: "YouTube",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.learner.biggestBlocker).toBe("I never know where to start");
    expect(res.body.data.profile.learner.selfRatedLevel).toBe("basics");
    expect(res.body.data.profile.referralSource).toBe("YouTube");
  });

  it("keeps a pre-multi-select answer readable, and lets it be cleared", async () => {
    const a = await register("setuplegacylang");
    // What a profile saved before the picker went multi-select looks like.
    await UserModel.findByIdAndUpdate(a.id, { preferredLanguage: "bn" });
    expect((await getProfile(a)).body.data.profile.preferredLanguages).toEqual(["bn"]);

    // Deselecting everything must actually stick — the legacy fallback would
    // otherwise resurrect the old answer on the next read.
    await patchProfile(a, { preferredLanguages: [] });
    expect((await getProfile(a)).body.data.profile.preferredLanguages).toEqual([]);
  });

  it("rejects a language outside the recorded set", async () => {
    const a = await register("setupbadlang");
    expect((await patchProfile(a, { preferredLanguages: ["klingon"] })).status).toBe(400);
  });

  it("rejects out-of-range years and unknown self-rated levels", async () => {
    const a = await register("setupbadvalues");
    expect((await patchProfile(a, { studyStartYear: 1800 })).status).toBe(400);
    expect((await patchProfile(a, { studyEndYear: YEAR_MAX + 1 })).status).toBe(400);
    expect((await patchProfile(a, { selfRatedLevel: "guru" })).status).toBe(400);
    // The far edge of the range is legitimate: a first-year gives an expected
    // graduation year several years out.
    expect((await patchProfile(a, { studyEndYear: YEAR_MAX })).status).toBe(200);
  });

  it("clamps an over-long role summary at the API rather than the database", async () => {
    const a = await register("setuplongrole");
    const res = await patchProfile(a, { roleSummary: "x".repeat(301) });
    expect(res.status).toBe(400);
  });
});

describe("step-2 answers are the student's, permanently", () => {
  it("the chat extractor cannot overwrite anything the student answered", async () => {
    const a = await register("setuppermanent");
    await patchProfile(a, {
      industry: "Fintech",
      careerGoal: "Get my first job",
      biggestBlocker: "I never know where to start",
      preferredStyle: "Worked examples",
    });

    // What a passive extraction pass would try to write after a few chat turns.
    await upsertLearnerProfile(
      a.id,
      {
        industry: "Gaming",
        careerGoal: "Become a designer",
        biggestBlocker: "no time",
        preferredStyle: "videos",
      },
      "chat",
    );

    const profile = await getLearnerProfile(a.id);
    expect(profile).toMatchObject({
      industry: "Fintech",
      careerGoal: "Get my first job",
      biggestBlocker: "I never know where to start",
      preferredStyle: "Worked examples",
    });
  });

  it("the extractor is never offered the fields it would have to invent", async () => {
    const a = await register("setupextractscope");
    const missing = emptyLearnerFields(await getLearnerProfile(a.id));
    for (const field of [
      "institutionName",
      "companyName",
      "studyStartYear",
      "studyEndYear",
      "roleSummary",
      "selfRatedLevel",
    ]) {
      expect(missing).not.toContain(field);
    }
    // It still gets the ones a student does state in passing.
    expect(missing).toContain("biggestBlocker");
    expect(missing).toContain("industry");
  });

  it("stops calling the model once every extractable field is filled", async () => {
    const a = await register("setupnogaps");
    await patchProfile(a, {
      ageBand: "18-24",
      occupation: "student",
      operatingSystem: "windows",
      educationLevel: "undergrad",
      educationDetail: "3rd year",
      fieldOfStudy: "CSE",
      industry: "Fintech",
      roleTitle: "Intern",
      experienceYears: 1,
      learningInterests: ["Web development"],
      careerGoal: "First job",
      weeklyHours: 6,
      preferredStyle: "Projects",
      biggestBlocker: "Consistency",
    });
    expect(emptyLearnerFields(await getLearnerProfile(a.id))).toEqual([]);
  });
});

describe("what reaches a prompt", () => {
  it("collapses a student's education into one line, institution and years included", async () => {
    const a = await register("setuprenderstudent");
    await patchProfile(a, {
      educationLevel: "undergrad",
      educationDetail: "3rd year",
      fieldOfStudy: "Computer Science",
      institutionName: "BUET",
      studyStartYear: 2022,
      studyEndYear: 2026,
    });
    const context = await buildLearnerContext(a.id);
    const education = context.split("\n").filter((l) => l.startsWith("Education:"));
    expect(education).toHaveLength(1);
    expect(education[0]).toContain("BUET");
    expect(education[0]).toContain("2022-2026");
  });

  it("collapses a professional's work into one line with the company and summary", async () => {
    const a = await register("setuprenderpro");
    await patchProfile(a, {
      roleTitle: "Backend Engineer",
      companyName: "Acme",
      industry: "Fintech",
      experienceYears: 4,
      roleSummary: "Owns the payments API",
    });
    const context = await buildLearnerContext(a.id);
    const work = context.split("\n").filter((l) => l.startsWith("Work:"));
    expect(work).toHaveLength(1);
    expect(work[0]).toContain("at Acme");
    expect(work[0]).toContain("Owns the payments API");
  });

  it("renders the self-rating as a claim, never as a measured fact", async () => {
    const a = await register("setuprenderlevel");
    await patchProfile(a, { selfRatedLevel: "professional" });
    const context = await buildLearnerContext(a.id);
    // renderMasterySlice puts the MEASURED level in the same prompt; this line
    // has to read as the student's own estimate or the two merge into one claim.
    expect(context).toContain("Says they are:");
    expect(context).toContain("their own estimate");
  });

  it("never leaks where the student heard about Saidrix into a prompt", async () => {
    const a = await register("setupreferral");
    await patchProfile(a, {
      referralSource: "Facebook ad",
      industry: "Fintech",
      careerGoal: "First job",
    });
    // It is on the profile the UI reads...
    expect((await getProfile(a)).body.data.profile.referralSource).toBe("Facebook ad");
    // ...and in neither of the two blocks an agent ever sees.
    expect(await buildLearnerContext(a.id)).not.toContain("Facebook");
    expect(await buildStudentContext(a.id)).not.toContain("Facebook");
  });

  it("says nothing at all for a student who has answered nothing", async () => {
    const a = await register("setupempty");
    await LearnerProfileModel.create({ userId: new mongoose.Types.ObjectId(a.id) });
    expect(await buildLearnerContext(a.id)).toBe("");
  });
});
