import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolCallResponse } from "./helpers/fakeLlm.js";
import type { WebSearchOptions, WebSearchResult } from "../src/agents/tools/web-search.js";
import type { LessonContext } from "../src/agents/lecture-maker/prompt.js";
import type { LessonBlueprint } from "../src/agents/lecture-maker/schema.js";

/**
 * The lecture's closing Resources section.
 *
 * The property under test throughout is that a link the student clicks always
 * came from a search result and never from a model. The picker tool has no url
 * field, and the parse step takes only candidate NUMBERS — so these tests are
 * mostly about proving that no path exists from model output to a URL, and that
 * every failure mode degrades to `null` rather than to a broken lecture.
 *
 * `isResourcesEnabled` reads the env parsed at import time, so each case loads
 * the module fresh behind a mocked config, like freshness.test.ts does.
 */

const CTX: LessonContext = {
  lessonId: "l1",
  courseTitle: "Modern React",
  courseDesc: "Production React",
  level: "Intermediate",
  chapterTitle: "Data",
  moduleTitle: "Fetching",
  topicTitle: "Fetching data in a component",
  siblingTopics: [],
};

const BLUEPRINT = {
  scope: "How a component loads server data.",
  objectives: ["Fetch data in a component"],
  assumedKnowledge: [],
  concepts: [{ name: "Effects", why: "It is the mechanism", hardBecause: "" }],
  examples: [{ name: "product-page", scenario: "Loading one product", teaches: "" }],
  misconceptions: [],
  visuals: [],
  outOfScope: [],
  currency: [],
} as LessonBlueprint;

const READING: WebSearchResult = {
  query: "r",
  sources: [
    { title: "React reference", url: "https://react.dev/reference/react", content: "Every hook." },
    { title: "MDN fetch", url: "https://developer.mozilla.org/en-US/docs/Web/API/fetch", content: "The API." },
    { title: "Paid course", url: "https://www.udemy.com/course/react", content: "Buy now." },
    { title: "Paid blog", url: "https://blog.udemy.com/react-tips", content: "Also theirs." },
  ],
};

const VIDEOS: WebSearchResult = {
  query: "v",
  sources: [
    // A channel, a playlist, a handle and a search page — Tavily returns all of
    // these for a "tutorial" query and none of them is a video on the topic.
    { title: "Channel", url: "https://www.youtube.com/channel/UCabcdefghijklmno" },
    { title: "Playlist", url: "https://www.youtube.com/playlist?list=PLabc" },
    { title: "Handle", url: "https://www.youtube.com/@somechannel" },
    { title: "Search", url: "https://www.youtube.com/results?search_query=react" },
    { title: "Real video", url: "https://www.youtube.com/watch?v=abcdefghijk&t=30s" },
    { title: "Short link", url: "https://youtu.be/zyxwvutsrqp" },
  ],
};

/** What the picker model returns. Deliberately hostile in most tests. */
type Emission = Record<string, unknown>;

interface LoadOptions {
  enabled?: boolean;
  reading?: WebSearchResult | Error;
  videos?: WebSearchResult | Error;
  emission?: Emission | Error;
  /** Status returned by the HEAD liveness check. */
  headStatus?: number;
}

async function load(opts: LoadOptions = {}) {
  vi.resetModules();
  const calls: { query: string; opts: WebSearchOptions }[] = [];

  const runWebSearch = vi.fn(async (query: string, o: WebSearchOptions = {}) => {
    calls.push({ query, opts: o });
    const which = o.includeDomains?.length ? opts.videos : opts.reading;
    const fallback = o.includeDomains?.length ? VIDEOS : READING;
    const result = which ?? fallback;
    if (result instanceof Error) throw result;
    return result;
  });

  vi.doMock("../src/config/env.js", async () => {
    const actual = await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js");
    return { ...actual, isResourcesEnabled: () => opts.enabled !== false };
  });
  vi.doMock("../src/agents/tools/web-search.js", async () => {
    const actual = await vi.importActual<typeof import("../src/agents/tools/web-search.js")>(
      "../src/agents/tools/web-search.js",
    );
    return { ...actual, runWebSearch };
  });

  const mod = await import("../src/agents/lecture-maker/resources.js");

  // A minimal chat-model fake, same style as lecture-maker.test.ts's.
  const emission = opts.emission ?? { intro: "Go further.", reading: [{ number: 1, why: "The reference." }] };
  const create = vi.fn(async () => {
    if (emission instanceof Error) throw emission;
    return toolCallResponse("emit_resource_picks", emission);
  });
  const deps = { chat: { bindTools: () => ({ invoke: create }) }, model: "m" } as never;

  return { ...mod, runWebSearch, calls, create, deps };
}

/** Every URL the student could end up clicking. */
function urlsOf(result: { block: { links: { url: string }[] } } | null): string[] {
  return (result?.block.links ?? []).map((l) => l.url);
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // The liveness pass would otherwise reach the real internet.
  vi.spyOn(globalThis, "fetch").mockResolvedValue({ status: 200 } as Response);
});

afterEach(() => {
  vi.doUnmock("../src/config/env.js");
  vi.doUnmock("../src/agents/tools/web-search.js");
  vi.restoreAllMocks();
});

describe("buildResourcesBlock", () => {
  it("does not search at all when disabled", async () => {
    const { buildResourcesBlock, runWebSearch } = await load({ enabled: false });
    expect(await buildResourcesBlock({ ctx: CTX, blueprint: BLUEPRINT })).toBeNull();
    expect(runWebSearch).not.toHaveBeenCalled();
  });

  it("searches reading with an exclude list and video with an include list", async () => {
    const { buildResourcesBlock, calls, deps } = await load();
    await buildResourcesBlock({ ctx: CTX, blueprint: BLUEPRINT, deps });

    expect(calls).toHaveLength(2);
    const reading = calls.find((c) => !c.opts.includeDomains)!;
    const video = calls.find((c) => c.opts.includeDomains)!;
    expect(reading.opts.excludeDomains).toContain("udemy.com");
    expect(video.opts.includeDomains).toEqual(["youtube.com", "youtu.be"]);
  });

  // The opposite of buildFreshnessQuery: for further reading the canonical
  // evergreen docs page is what we want, and a year is what pushes it out.
  it("does not put the year in either query", async () => {
    const { buildResourcesBlock, calls, deps } = await load();
    await buildResourcesBlock({ ctx: CTX, blueprint: BLUEPRINT, deps });
    for (const c of calls) expect(c.query).not.toContain(String(new Date().getFullYear()));
  });

  it("never emits a URL the model wrote", async () => {
    const { buildResourcesBlock, deps } = await load({
      emission: {
        intro: "Go further.",
        // Every hostile shape at once: a fabricated url, a fabricated title, an
        // out-of-range number and a duplicate.
        reading: [
          { number: 1, why: "Real pick.", url: "https://totally-made-up.example/react", title: "Invented" },
          { number: 99, why: "Out of range." },
          { number: 1, why: "Duplicate." },
        ],
        video: { number: 1, why: "The video.", url: "https://evil.example/watch" },
      },
    });
    const result = await buildResourcesBlock({ ctx: CTX, blueprint: BLUEPRINT, deps });

    const candidateUrls = [
      "https://react.dev/reference/react",
      "https://developer.mozilla.org/en-US/docs/Web/API/fetch",
      "https://www.youtube.com/watch?v=abcdefghijk",
      "https://www.youtube.com/watch?v=zyxwvutsrqp",
    ];
    for (const url of urlsOf(result)) expect(candidateUrls).toContain(url);
    expect(urlsOf(result)).not.toContain("https://totally-made-up.example/react");
    // The duplicate and the out-of-range pick are dropped, not repaired.
    expect(result!.block.links.filter((l) => l.kind !== "video")).toHaveLength(1);
  });

  it("drops paid-course domains the search returned anyway", async () => {
    const { buildResourcesBlock, deps } = await load({
      // Ask for all four reading candidates; only the two free ones exist by now.
      emission: {
        intro: "Go further.",
        reading: [1, 2, 3, 4].map((number) => ({ number, why: "Pick." })),
      },
    });
    const result = await buildResourcesBlock({ ctx: CTX, blueprint: BLUEPRINT, deps });
    for (const url of urlsOf(result)) expect(url).not.toContain("udemy.com");
    expect(urlsOf(result)).toHaveLength(2);
  });

  it("keeps only real watch pages, and canonicalizes them", async () => {
    const { buildResourcesBlock, deps } = await load({
      emission: { intro: "Go further.", reading: [{ number: 1, why: "x" }], video: { number: 1, why: "y" } },
    });
    const result = await buildResourcesBlock({ ctx: CTX, blueprint: BLUEPRINT, deps });
    const video = result!.block.links.find((l) => l.kind === "video")!;
    // Candidate 1 is the channel in the fixture; after filtering it must be the
    // first REAL video, with its tracking param stripped.
    expect(video.url).toBe("https://www.youtube.com/watch?v=abcdefghijk");
  });

  it("allows at most one video", async () => {
    const { buildResourcesBlock, deps } = await load({
      emission: { intro: "x", reading: [{ number: 1, why: "a" }], video: { number: 2, why: "b" } },
    });
    const result = await buildResourcesBlock({ ctx: CTX, blueprint: BLUEPRINT, deps });
    expect(result!.block.links.filter((l) => l.kind === "video")).toHaveLength(1);
  });

  it("still returns reading when the video search fails", async () => {
    const { buildResourcesBlock, deps } = await load({ videos: new Error("tavily down") });
    const result = await buildResourcesBlock({ ctx: CTX, blueprint: BLUEPRINT, deps });
    expect(result!.block.links.length).toBeGreaterThan(0);
    expect(result!.block.links.every((l) => l.kind !== "video")).toBe(true);
  });

  it("returns null when both searches fail", async () => {
    const { buildResourcesBlock, deps } = await load({
      reading: new Error("down"),
      videos: new Error("down"),
    });
    expect(await buildResourcesBlock({ ctx: CTX, blueprint: BLUEPRINT, deps })).toBeNull();
  });

  it("returns null when the picker keeps failing, instead of throwing", async () => {
    const { buildResourcesBlock, deps } = await load({ emission: new Error("502") });
    await expect(buildResourcesBlock({ ctx: CTX, blueprint: BLUEPRINT, deps })).resolves.toBeNull();
  });

  it("returns null when every pick is out of range", async () => {
    const { buildResourcesBlock, deps } = await load({
      emission: { intro: "x", reading: [{ number: 40, why: "nope" }] },
    });
    expect(await buildResourcesBlock({ ctx: CTX, blueprint: BLUEPRINT, deps })).toBeNull();
  });

  it("drops a reading link the web says is gone", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({ status: 404 } as Response);
    const { buildResourcesBlock, deps } = await load({ videos: { query: "v", sources: [] } });
    expect(await buildResourcesBlock({ ctx: CTX, blueprint: BLUEPRINT, deps })).toBeNull();
  });

  it("keeps a link whose host merely refuses HEAD", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNRESET"));
    const { buildResourcesBlock, deps } = await load();
    const result = await buildResourcesBlock({ ctx: CTX, blueprint: BLUEPRINT, deps });
    expect(result!.block.links.length).toBeGreaterThan(0);
  });

  it("falls back to a written intro when the model omits one", async () => {
    const { buildResourcesBlock, deps } = await load({
      emission: { reading: [{ number: 1, why: "The reference." }] },
    });
    const result = await buildResourcesBlock({ ctx: CTX, blueprint: BLUEPRINT, deps });
    expect(result!.block.intro.length).toBeGreaterThan(0);
  });

  it("titles the section in the lecture's language", async () => {
    const { buildResourcesBlock, RESOURCES_TITLE, deps } = await load();
    const bn = await buildResourcesBlock({
      ctx: { ...CTX, language: "bn" },
      blueprint: BLUEPRINT,
      deps,
    });
    expect(bn!.topicTitle).toBe(RESOURCES_TITLE.bn);
  });
});

describe("url helpers", () => {
  it("blocks a paid domain and its subdomains but not a lookalike", async () => {
    const { isBlockedUrl } = await load();
    expect(isBlockedUrl("https://www.udemy.com/course/x")).toBe(true);
    expect(isBlockedUrl("https://blog.udemy.com/y")).toBe(true);
    expect(isBlockedUrl("https://myudemy.org/free")).toBe(false);
    expect(isBlockedUrl("not a url")).toBe(true);
  });

  it("resolves a video id only from real single-video urls", async () => {
    const { youtubeVideoId } = await load();
    expect(youtubeVideoId("https://www.youtube.com/watch?v=abcdefghijk")).toBe("abcdefghijk");
    expect(youtubeVideoId("https://youtu.be/abcdefghijk")).toBe("abcdefghijk");
    expect(youtubeVideoId("https://www.youtube.com/shorts/abcdefghijk")).toBe("abcdefghijk");
    expect(youtubeVideoId("https://www.youtube.com/channel/UCabcdefghijklmno")).toBeNull();
    expect(youtubeVideoId("https://www.youtube.com/playlist?list=PLabc")).toBeNull();
    expect(youtubeVideoId("https://www.youtube.com/@somechannel")).toBeNull();
    expect(youtubeVideoId("https://vimeo.com/12345")).toBeNull();
  });
});
