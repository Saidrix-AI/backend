import OpenAI from "openai";
import { ragConfig } from "../config/env.js";

/**
 * Embeddings via any OpenAI-compatible endpoint (base URL + key + model are all
 * env-driven — see ragConfig). Defaults to OpenRouter, but note OpenRouter may
 * not serve an /embeddings route for every model; if a request comes back with
 * no vectors we throw a clear error naming the endpoint and model rather than
 * silently upserting garbage. Mirrors the raw-client style in agents/llm.ts.
 */

const BATCH_SIZE = 96;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!ragConfig.embeddingApiKey) {
    throw new Error("EMBEDDING_API_KEY (or OPENROUTER_API_KEY) is not configured for embeddings.");
  }
  if (!client) {
    client = new OpenAI({
      apiKey: ragConfig.embeddingApiKey,
      baseURL: ragConfig.embeddingBaseUrl,
    });
  }
  return client;
}

/** Embeds many texts, batched, preserving input order. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!ragConfig.embeddingModel) {
    throw new Error("EMBEDDING_MODEL is not configured.");
  }
  if (texts.length === 0) return [];

  const oai = getClient();
  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await oai.embeddings.create({ model: ragConfig.embeddingModel, input: batch });

    if (!res.data || res.data.length !== batch.length) {
      throw new Error(
        `Embeddings endpoint (${ragConfig.embeddingBaseUrl}) returned ${res.data?.length ?? 0} ` +
          `vectors for ${batch.length} inputs — does model "${ragConfig.embeddingModel}" support ` +
          `embeddings on this provider? If not, set EMBEDDING_BASE_URL to an OpenAI-compatible ` +
          `embeddings provider.`,
      );
    }

    // The API may return items out of order; sort by index to be safe.
    for (const item of [...res.data].sort((a, b) => a.index - b.index)) {
      if (!Array.isArray(item.embedding)) {
        throw new Error("Embeddings response contained no vector data.");
      }
      out.push(item.embedding as number[]);
    }
  }

  return out;
}

/** Convenience for a single query embedding. */
export async function embedOne(text: string): Promise<number[]> {
  const [vector] = await embed([text]);
  if (!vector) throw new Error("Embedding returned no vector.");
  return vector;
}
