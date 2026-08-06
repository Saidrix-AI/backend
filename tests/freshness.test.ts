import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSearchResult } from "../src/agents/tools/web-search.js";

/**
 * The freshness layer is best-effort by contract: a course or lecture must
 * still generate when the search is off, empty or failing. These tests pin that
 * contract, plus the two properties that decide whether it earns its cost — the
 * query biases towards current material, and a course's many chapter searches
 * are not N billed round-trips for the same question.
 *
 * `isFreshnessEnabled` reads the env parsed at import time, so each case loads
 * the module fresh behind a mocked config rather than mutating process.env.
 */

const RESULT: WebSearchResult = {
  query: "q",
  answer: "React 19 is the current release.",
  sources: [
    { title: "React 19", url: "https://react.dev/blog", content: "React 19 was released in December." },
    { title: "Blank", url: "https://example.com", content: "   " },
  ],
};

/** Loads freshness.ts with the flag forced on/off and web search stubbed. */
async function load(enabled: boolean, search: () => Promise<WebSearchResult>) {
  vi.resetModules();
  const runWebSearch = vi.fn(search);
  vi.doMock("../src/config/env.js", async () => {
    const actual = await vi.importActual<typeof import("../src/config/env.js")>(
      "../src/config/env.js",
    );
    return { ...actual, isFreshnessEnabled: () => enabled };
  });
  vi.doMock("../src/agents/tools/web-search.js", async () => {
    const actual = await vi.importActual<typeof import("../src/agents/tools/web-search.js")>(
      "../src/agents/tools/web-search.js",
    );
    return { ...actual, runWebSearch };
  });
  const mod = await import("../src/agents/shared/freshness.js");
  mod.clearFreshnessCache();
  return { ...mod, runWebSearch };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.doUnmock("../src/config/env.js");
  vi.doUnmock("../src/agents/tools/web-search.js");
  vi.restoreAllMocks();
});

describe("buildFreshnessQuery", () => {
  it("appends the current year, so the search surfaces what changed rather than the evergreen page", async () => {
    const { buildFreshnessQuery } = await load(true, async () => RESULT);
    const q = buildFreshnessQuery("React hooks");
    expect(q).toContain("React hooks");
    expect(q).toContain(String(new Date().getFullYear()));
  });

  it("caps the subject, because a long query dilutes search relevance", async () => {
    const { buildFreshnessQuery } = await load(true, async () => RESULT);
    expect(buildFreshnessQuery("x".repeat(500)).length).toBeLessThan(200);
  });
});

describe("retrieveFreshContext", () => {
  it("does not search at all when the flag is off", async () => {
    const { retrieveFreshContext, runWebSearch } = await load(false, async () => RESULT);
    expect(await retrieveFreshContext("React")).toEqual({ block: "", sources: [], count: 0 });
    expect(runWebSearch).not.toHaveBeenCalled();
  });

  it("does not search for an empty topic", async () => {
    const { retrieveFreshContext, runWebSearch } = await load(true, async () => RESULT);
    expect((await retrieveFreshContext("   ")).block).toBe("");
    expect(runWebSearch).not.toHaveBeenCalled();
  });

  it("builds a block that dates the search and overrides the model's own memory", async () => {
    const { retrieveFreshContext, today } = await load(true, async () => RESULT);
    const { block, count } = await retrieveFreshContext("React");

    expect(block).toContain("CURRENT INFORMATION");
    expect(block).toContain(today());
    expect(block).toContain("THIS IS CORRECT");
    // The prompts lean on these instructions; losing them silently would make
    // the whole layer advisory.
    expect(block).toContain("deprecated");
    expect(block).toContain("Never state a version number");
    expect(block).toContain("React 19 was released in December.");
    // The blank-content source is dropped rather than shipped as an empty citation.
    expect(block).not.toContain("Blank");
    expect(count).toBe(1);
  });

  it("returns nothing when the search returns nothing usable", async () => {
    const { retrieveFreshContext } = await load(true, async () => ({ query: "q", sources: [] }));
    expect((await retrieveFreshContext("React")).block).toBe("");
  });

  it("swallows a search failure — generation must survive Tavily being down", async () => {
    const { retrieveFreshContext } = await load(true, async () => {
      throw new Error("502 from Tavily");
    });
    await expect(retrieveFreshContext("React")).resolves.toEqual({ block: "", sources: [], count: 0 });
  });

  it("reuses a cached answer, so a course's chapter searches are not billed twice", async () => {
    const { retrieveFreshContext, runWebSearch } = await load(true, async () => RESULT);
    const first = await retrieveFreshContext("React");
    const second = await retrieveFreshContext("React");
    expect(runWebSearch).toHaveBeenCalledTimes(1);
    expect(second.block).toBe(first.block);
  });

  it("searches again for a different topic", async () => {
    const { retrieveFreshContext, runWebSearch } = await load(true, async () => RESULT);
    await retrieveFreshContext("React");
    await retrieveFreshContext("Django");
    expect(runWebSearch).toHaveBeenCalledTimes(2);
  });
});
