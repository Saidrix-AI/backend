import { Pinecone } from "@pinecone-database/pinecone";
import { ragConfig } from "../config/env.js";

/** Thin wrapper over the Pinecone client scoped to our index + namespace. */

let pc: Pinecone | null = null;

function client(): Pinecone {
  if (!ragConfig.pineconeApiKey) throw new Error("PINECONE_API_KEY is not configured.");
  if (!pc) pc = new Pinecone({ apiKey: ragConfig.pineconeApiKey });
  return pc;
}

function namespaced() {
  return client().index(ragConfig.pineconeIndex).namespace(ragConfig.pineconeNamespace);
}

/** Creates the serverless index (cosine, EMBEDDING_DIMENSIONS) if it's missing. */
export async function ensureIndex(): Promise<void> {
  if (!ragConfig.embeddingDimensions) {
    throw new Error("EMBEDDING_DIMENSIONS is required to create the Pinecone index.");
  }
  const pcc = client();
  const list = await pcc.listIndexes();
  if (list.indexes?.some((i) => i.name === ragConfig.pineconeIndex)) return;

  await pcc.createIndex({
    name: ragConfig.pineconeIndex,
    dimension: ragConfig.embeddingDimensions,
    metric: "cosine",
    spec: {
      serverless: {
        cloud: ragConfig.pineconeCloud as "aws" | "gcp" | "azure",
        region: ragConfig.pineconeRegion,
      },
    },
    waitUntilReady: true,
    suppressConflicts: true,
  });
}

export type VectorMetadata = Record<string, string | number | boolean>;

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

export async function upsertVectors(records: VectorRecord[]): Promise<void> {
  if (records.length === 0) return;
  const index = namespaced();
  const BATCH = 100;
  for (let i = 0; i < records.length; i += BATCH) {
    await index.upsert({ records: records.slice(i, i + BATCH) });
  }
}

export interface QueryMatch {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export async function queryVectors(
  vector: number[],
  topK: number,
  filter?: Record<string, unknown>,
): Promise<QueryMatch[]> {
  const res = await namespaced().query({
    vector,
    topK,
    includeMetadata: true,
    ...(filter ? { filter } : {}),
  });
  return (res.matches ?? []).map((m) => ({
    id: m.id,
    score: m.score ?? 0,
    metadata: (m.metadata ?? {}) as Record<string, unknown>,
  }));
}

/** Existing id → content hash, for skipping unchanged chunks on re-ingest. */
export async function fetchHashes(ids: string[]): Promise<Map<string, string>> {
  const index = namespaced();
  const out = new Map<string, string>();
  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const res = await index.fetch({ ids: ids.slice(i, i + BATCH) });
    for (const [id, rec] of Object.entries(res.records ?? {})) {
      const h = (rec.metadata as Record<string, unknown> | undefined)?.hash;
      if (typeof h === "string") out.set(id, h);
    }
  }
  return out;
}
