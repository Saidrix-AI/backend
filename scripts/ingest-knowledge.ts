// Ingests the Course-Content curriculum into Pinecone for RAG.
//   Run:   npx tsx scripts/ingest-knowledge.ts          (incremental — skips unchanged)
//          npx tsx scripts/ingest-knowledge.ts --force   (re-embed everything)
// Requires the RAG env vars (PINECONE_API_KEY, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS,
// and an embeddings key). Needs no database connection.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRagEnabled, ragConfig } from "../src/config/env.js";
import { chunkFile, chunkHash, chunkId, embeddingText, type Chunk } from "../src/rag/chunk.js";
import { embed } from "../src/rag/embeddings.js";
import { ensureIndex, fetchHashes, upsertVectors, type VectorRecord } from "../src/rag/pinecone.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.resolve(here, "../../Course-Content");
const force = process.argv.includes("--force");

/** Recursively collect every README.md under Course-Content except the root index. */
function findReadmes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...findReadmes(full));
    else if (name === "README.md" && path.dirname(full) !== CONTENT_DIR) out.push(full);
  }
  return out;
}

/** Stable, forward-slashed repo-relative path used for metadata + chunk ids. */
function relPath(full: string): string {
  return `Course-Content/${path.relative(CONTENT_DIR, full).split(path.sep).join("/")}`;
}

async function main() {
  if (!isRagEnabled()) {
    console.error(
      "RAG is not configured. Set PINECONE_API_KEY, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS and an " +
        "embeddings key (EMBEDDING_API_KEY or OPENROUTER_API_KEY) in .env, then re-run.",
    );
    process.exit(1);
  }

  console.log(`Scanning ${CONTENT_DIR} …`);
  const files = findReadmes(CONTENT_DIR);
  console.log(`Found ${files.length} skill files.`);

  const chunks: Chunk[] = [];
  for (const file of files) {
    chunks.push(...chunkFile(readFileSync(file, "utf8"), relPath(file)));
  }
  console.log(`Produced ${chunks.length} chunks.`);

  console.log("Ensuring Pinecone index exists (creating on first run may take ~30-60s)…");
  await ensureIndex();

  // Idempotency: skip chunks whose content hash already matches what's stored.
  console.log("Checking which chunks are already up to date…");
  const hashById = new Map(chunks.map((c) => [chunkId(c), chunkHash(c)]));
  const existing = force ? new Map<string, string>() : await fetchHashes([...hashById.keys()]);
  const toEmbed = chunks.filter((c) => existing.get(chunkId(c)) !== chunkHash(c));

  console.log(
    force
      ? `Force mode: embedding all ${toEmbed.length} chunks.`
      : `${toEmbed.length} new/changed chunks to embed (${chunks.length - toEmbed.length} unchanged, skipped).`,
  );
  if (toEmbed.length === 0) {
    console.log("Nothing to do — index is up to date.");
    return;
  }

  const estTokens = Math.round(toEmbed.reduce((n, c) => n + embeddingText(c).length, 0) / 4);
  console.log(`~${estTokens.toLocaleString()} tokens to embed with "${ragConfig.embeddingModel}". Working in batches…`);

  const toRecord = (c: Chunk, values: number[]): VectorRecord => ({
    id: chunkId(c),
    values,
    metadata: {
      skill: c.skill,
      category: c.category,
      categoryNumber: c.categoryNumber,
      level: c.level,
      section: c.section,
      sourcePath: c.sourcePath,
      chunkIndex: c.chunkIndex,
      text: c.text,
      hash: chunkHash(c),
    },
  });

  // Embed + upsert one batch at a time so progress is visible and persisted:
  // a stopped run resumes from where it left off (unchanged chunks are skipped).
  const BATCH = 96;
  let done = 0;
  for (let i = 0; i < toEmbed.length; i += BATCH) {
    const batch = toEmbed.slice(i, i + BATCH);
    const vectors = await embed(batch.map(embeddingText));
    if (vectors[0] && vectors[0].length !== ragConfig.embeddingDimensions) {
      throw new Error(
        `Embedding model returned ${vectors[0].length}-dim vectors but EMBEDDING_DIMENSIONS=${ragConfig.embeddingDimensions}. ` +
          `Fix EMBEDDING_DIMENSIONS to match the model and recreate the index if needed.`,
      );
    }
    await upsertVectors(batch.map((c, j) => toRecord(c, vectors[j]!)));
    done += batch.length;
    console.log(`  …${done}/${toEmbed.length} embedded + upserted`);
  }

  console.log(`Done. Upserted ${done} vectors into "${ragConfig.pineconeIndex}" / "${ragConfig.pineconeNamespace}".`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
