import { describe, expect, it } from "vitest";
import { inferIcon, refineIcon } from "../src/services/iconInference.js";
import { BRAND_ICON_NAMES, COURSE_ICON_NAMES } from "../src/validation/course.schema.js";

describe("inferIcon", () => {
  it("picks the brand a title names", () => {
    expect(inferIcon("React Fundamentals")).toBe("react");
    expect(inferIcon("Python Basics")).toBe("python");
    expect(inferIcon("Mastering Docker & Kubernetes")).toBe("kubernetes"); // k8s rule runs first
    expect(inferIcon("Build APIs with Django")).toBe("django");
  });

  // These are the pairs a naive substring match gets wrong.
  it("does not confuse overlapping language names", () => {
    expect(inferIcon("JavaScript Basics")).toBe("javascript");
    expect(inferIcon("Core Java Programming")).toBe("java");
    expect(inferIcon("TypeScript for React Developers")).toBe("typescript");
    expect(inferIcon("Next.js App Router")).toBe("nextjs");
    expect(inferIcon("Node.js Backend Development")).toBe("node");
  });

  it("falls back to a contextual generic when the subject has no brand mark", () => {
    expect(inferIcon("SQL এর মৌলিক ধারণা — SQL basics")).toBe("database");
    expect(inferIcon("Machine Learning Fundamentals")).toBe("brain");
    expect(inferIcon("Data Analysis with spreadsheets")).toBe("chart");
    expect(inferIcon("Algorithms Essentials")).toBe("code");
    expect(inferIcon("System Design Interview Prep")).toBe("layers");
    expect(inferIcon("Cyber Security Foundations")).toBe("lock");
  });

  it("returns null rather than guessing on an unrelated title", () => {
    expect(inferIcon("Business English for Beginners")).toBeNull();
    expect(inferIcon("Introduction to Microeconomics")).toBeNull();
  });

  it("only ever emits names the contract allows", () => {
    const allowed = new Set<string>(COURSE_ICON_NAMES);
    const titles = [
      "React Fundamentals", "Python Basics", "JavaScript Basics", "Core Java",
      "SQL basics", "Machine Learning", "Data Analysis", "Algorithms",
      "Docker in practice", "AWS cloud fundamentals", "System Design", "DevOps CI/CD",
    ];
    for (const t of titles) {
      const icon = inferIcon(t);
      if (icon) expect(allowed, `"${t}" → ${icon}`).toContain(icon);
    }
  });
});

describe("refineIcon", () => {
  // Inference is a safety net for vague generics, not a second-guess of the model.
  it("keeps a brand the model deliberately chose", () => {
    expect(refineIcon("pytorch", "Deep Learning with TensorFlow")).toBe("pytorch");
    expect(refineIcon("django", "Python Web Development")).toBe("django");
  });

  it("upgrades a vague generic using the title", () => {
    expect(refineIcon("book", "React Fundamentals")).toBe("react");
    expect(refineIcon("code", "JavaScript Basics")).toBe("javascript");
    expect(refineIcon("book", "Algorithms Essentials")).toBe("code");
  });

  it("leaves the generic alone when nothing is inferable", () => {
    expect(refineIcon("book", "Business English for Beginners")).toBe("book");
    expect(refineIcon(undefined, "Business English")).toBe("book");
  });

  it("is idempotent — re-running never churns a row", () => {
    const once = refineIcon("book", "React Fundamentals");
    expect(refineIcon(once, "React Fundamentals")).toBe(once);
    expect(BRAND_ICON_NAMES as readonly string[]).toContain(once);
  });
});
