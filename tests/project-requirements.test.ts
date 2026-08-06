import { describe, expect, it } from "vitest";
import { makeProjectRequirements } from "../src/agents/project-requirements/index.js";
import {
  buildRequirementsUserMessage,
  type ProjectContext,
} from "../src/agents/project-requirements/prompt.js";
import { projectRequirementsSchema } from "../src/agents/project-requirements/schema.js";
import { fakeDeps, sentMessages, textResponse, toolCallResponse } from "./helpers/fakeLlm.js";

const CTX: ProjectContext = {
  title: "Number Guessing Game",
  desc: "A CLI game that asks the player to guess a random number.",
  tags: ["python"],
  courseTitle: "Python Basics",
};

const GOOD = {
  goal: "Build a command-line game where the player guesses a randomly chosen number until correct.",
  requirements: [
    "Must define a main() function as the entry point",
    "Must use the random module to pick the target number",
    "Must loop until the player guesses correctly",
    "Must handle non-numeric input without crashing",
  ],
};

describe("projectRequirementsSchema", () => {
  it("accepts a well-formed checklist", () => {
    expect(projectRequirementsSchema.safeParse(GOOD).success).toBe(true);
  });

  it("rejects fewer than four requirements", () => {
    const r = projectRequirementsSchema.safeParse({ ...GOOD, requirements: GOOD.requirements.slice(0, 3) });
    expect(r.success).toBe(false);
  });

  it("rejects more than eight requirements", () => {
    const requirements = Array.from({ length: 9 }, (_, i) => `Must do thing ${i}`);
    expect(projectRequirementsSchema.safeParse({ ...GOOD, requirements }).success).toBe(false);
  });

  it("rejects an empty goal", () => {
    expect(projectRequirementsSchema.safeParse({ ...GOOD, goal: "   " }).success).toBe(false);
  });
});

describe("buildRequirementsUserMessage", () => {
  it("carries title, description, tags and course", () => {
    const msg = buildRequirementsUserMessage(CTX);
    expect(msg).toContain("Number Guessing Game");
    expect(msg).toContain("guess a random number");
    expect(msg).toContain("python");
    expect(msg).toContain("Python Basics");
  });

  it("tells the model to infer when no description is given", () => {
    const msg = buildRequirementsUserMessage({ title: "Todo App", desc: "", tags: [] });
    expect(msg).toContain("infer from the title");
    expect(msg).not.toContain("Part of the course");
  });
});

describe("makeProjectRequirements", () => {
  it("returns the checklist on a valid emission", async () => {
    const { deps, create } = fakeDeps(toolCallResponse("emit_requirements", GOOD));
    await expect(makeProjectRequirements(CTX, deps)).resolves.toEqual(GOOD);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("repairs a too-short checklist then succeeds", async () => {
    const { deps, create } = fakeDeps(
      toolCallResponse("emit_requirements", { ...GOOD, requirements: ["Must exist"] }),
      toolCallResponse("emit_requirements", GOOD),
    );
    await expect(makeProjectRequirements(CTX, deps)).resolves.toEqual(GOOD);
    expect(sentMessages(create, 1)).toContain("requirements:");
  });

  it("throws 502 after two failed attempts", async () => {
    const { deps } = fakeDeps(toolCallResponse("emit_requirements", { goal: "x" }), textResponse("sorry"));
    await expect(makeProjectRequirements(CTX, deps)).rejects.toMatchObject({ statusCode: 502 });
  });
});
