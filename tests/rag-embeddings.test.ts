import { describe, expect, it, beforeEach, vi } from "vitest";

// Mock the OpenAI SDK and the resolved ragConfig so embed() runs without real creds.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("openai", () => ({
  default: class {
    embeddings = { create: createMock };
    constructor(_opts: unknown) {}
  },
}));

vi.mock("../src/config/env.js", () => ({
  ragConfig: {
    embeddingApiKey: "test-key",
    embeddingBaseUrl: "http://embeddings.test",
    embeddingModel: "test-embed",
    embeddingDimensions: 3,
  },
}));

const { embed, embedOne } = await import("../src/rag/embeddings.js");

beforeEach(() => createMock.mockReset());

describe("embed", () => {
  it("returns [] for empty input without calling the API", async () => {
    expect(await embed([])).toEqual([]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("preserves input order even if the API returns items out of order", async () => {
    createMock.mockResolvedValue({
      data: [
        { index: 1, embedding: [1, 1, 1] },
        { index: 0, embedding: [0, 0, 0] },
      ],
    });
    expect(await embed(["a", "b"])).toEqual([
      [0, 0, 0],
      [1, 1, 1],
    ]);
  });

  it("fast-fails when the endpoint returns no/short vector data", async () => {
    createMock.mockResolvedValue({ data: [] });
    await expect(embed(["a"])).rejects.toThrow(/returned 0 vectors/);
  });

  it("embedOne returns a single vector", async () => {
    createMock.mockResolvedValue({ data: [{ index: 0, embedding: [9, 8, 7] }] });
    expect(await embedOne("hi")).toEqual([9, 8, 7]);
  });
});
