import { describe, expect, it } from "vitest";
import { buildPathBoundary } from "../src/agents/course-maker/prompt.js";

const COURSES = [
  { title: "Python Basics", covers: "syntax, variables, control flow, functions" },
  { title: "Data Analysis with Pandas", covers: "DataFrames, filtering, groupby, plotting" },
  { title: "Machine Learning", covers: "scikit-learn, training, evaluation" },
];
const GOAL = "Become a Data Scientist";

describe("buildPathBoundary", () => {
  it("marks the first step as having no prerequisites and defers later steps", () => {
    const b = buildPathBoundary(GOAL, COURSES, 1);
    expect(b).toContain("STEP 1 OF 3");
    expect(b).toContain("FIRST step");
    // later courses are deferred, not taught here
    expect(b).toContain("do NOT cover these");
    expect(b).toContain("Data Analysis with Pandas");
    expect(b).toContain("Machine Learning");
    // this course's own slice
    expect(b).toContain("Cover ONLY this course's own slice: syntax, variables");
  });

  it("turns earlier steps into prerequisites for a middle step", () => {
    const b = buildPathBoundary(GOAL, COURSES, 2);
    expect(b).toContain("STEP 2 OF 3");
    expect(b).toContain("PREREQUISITES");
    expect(b).toContain("Python Basics"); // earlier → prereq
    expect(b).toContain("Machine Learning"); // later → deferred
    expect(b).toContain("Cover ONLY this course's own slice: DataFrames");
  });

  it("has no deferral section for the last step", () => {
    const b = buildPathBoundary(GOAL, COURSES, 3);
    expect(b).toContain("STEP 3 OF 3");
    expect(b).toContain("PREREQUISITES");
    expect(b).toContain("Python Basics");
    expect(b).toContain("Data Analysis with Pandas");
    expect(b).not.toContain("do NOT cover these"); // nothing left to defer
  });
});
