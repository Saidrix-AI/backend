// Replaces the RAG corpus with the lesson PDFs: wipes the Pinecone namespace,
// then embeds every PDF in the folder.
//   Run:   npx tsx scripts/ingest-pdfs.ts ["D:/Data of Lesson/output/pdf"] [--dry]
//   --dry  converts + chunks only and prints a sample; touches nothing remote.
// Needs `pdftotext` (poppler) on PATH — Git for Windows ships it.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { isRagEnabled, ragConfig } from "../src/config/env.js";
import {
  chunkFile,
  chunkHash,
  chunkId,
  embeddingText,
  mergeSmallChunks,
  type Chunk,
} from "../src/rag/chunk.js";
import { embed } from "../src/rag/embeddings.js";
import { pdfCategory, pdfTextToMarkdown } from "../src/rag/pdfText.js";
import { deleteAllVectors, ensureIndex, upsertVectors, type VectorRecord } from "../src/rag/pinecone.js";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const dir = args.find((a) => !a.startsWith("--")) ?? "D:/Data of Lesson/output/pdf";

function pdfText(file: string): string {
  return execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function main() {
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
  console.log(`Found ${files.length} PDFs in ${dir}.`);

  const chunks: Chunk[] = [];
  for (const name of files) {
    const markdown = pdfTextToMarkdown(pdfText(path.join(dir, name)));
    chunks.push(...mergeSmallChunks(chunkFile(markdown, `Lesson-PDFs/${name}`, pdfCategory(name))));
  }
  console.log(`Produced ${chunks.length} chunks.`);

  if (dry) {
    for (const c of chunks.filter((c) => c.sourcePath.includes("python-foundation")).slice(0, 4)) {
      console.log(`\n--- ${chunkId(c)} [${c.category}] ${c.skill} · ${c.section}\n${c.text.slice(0, 400)}`);
    }
    return;
  }

  if (!isRagEnabled()) {
    console.error("RAG is not configured (PINECONE_API_KEY, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, key).");
    process.exit(1);
  }

  await ensureIndex();
  console.log(`Deleting every vector in "${ragConfig.pineconeIndex}" / "${ragConfig.pineconeNamespace}"…`);
  await deleteAllVectors();

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

  const BATCH = 96;
  let done = 0;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const vectors = await embed(batch.map(embeddingText));
    if (vectors[0] && vectors[0].length !== ragConfig.embeddingDimensions) {
      throw new Error(`Got ${vectors[0].length}-dim vectors but EMBEDDING_DIMENSIONS=${ragConfig.embeddingDimensions}.`);
    }
    await upsertVectors(batch.map((c, j) => toRecord(c, vectors[j]!)));
    done += batch.length;
    console.log(`  …${done}/${chunks.length} embedded + upserted`);
  }
  console.log(`Done. ${done} vectors from ${files.length} PDFs.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
