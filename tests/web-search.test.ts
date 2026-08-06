import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Tavily request body. Only the domain filters are asserted: they are the
 * mechanism behind two product rules — "no paid courses" and "the video slot
 * must be a video" — so a silently dropped filter would not fail anything else.
 */

async function load() {
  vi.resetModules();
  vi.doMock("../src/config/env.js", async () => {
    const actual = await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js");
    return { ...actual, env: { ...actual.env, TAVILY_API_KEY: "test-key" } };
  });
  return import("../src/agents/tools/web-search.js");
}

/** The parsed JSON body of the last fetch call. */
function lastBody(): Record<string, unknown> {
  const call = vi.mocked(globalThis.fetch).mock.calls.at(-1)!;
  return JSON.parse((call[1] as RequestInit).body as string);
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({ answer: "a", results: [] }),
  } as Response);
});

afterEach(() => {
  vi.doUnmock("../src/config/env.js");
  vi.restoreAllMocks();
});

describe("runWebSearch domain filters", () => {
  it("omits both filters by default", async () => {
    const { runWebSearch } = await load();
    await runWebSearch("react hooks");
    const body = lastBody();
    expect(body).not.toHaveProperty("include_domains");
    expect(body).not.toHaveProperty("exclude_domains");
    expect(body.query).toBe("react hooks");
  });

  it("sends include_domains when given", async () => {
    const { runWebSearch } = await load();
    await runWebSearch("q", { includeDomains: ["youtube.com", "youtu.be"] });
    expect(lastBody().include_domains).toEqual(["youtube.com", "youtu.be"]);
  });

  it("sends exclude_domains when given", async () => {
    const { runWebSearch } = await load();
    await runWebSearch("q", { excludeDomains: ["udemy.com"] });
    expect(lastBody().exclude_domains).toEqual(["udemy.com"]);
  });

  it("ignores empty arrays rather than sending an empty filter", async () => {
    const { runWebSearch } = await load();
    await runWebSearch("q", { includeDomains: [], excludeDomains: [] });
    const body = lastBody();
    expect(body).not.toHaveProperty("include_domains");
    expect(body).not.toHaveProperty("exclude_domains");
  });
});
