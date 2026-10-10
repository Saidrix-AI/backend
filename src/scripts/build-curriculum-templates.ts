/**
 * Builds the curriculum templates (one per lesson PDF) from the text already in
 * the Pinecone index, and saves them to Mongo.
 *
 * scripts/ingest-pdfs.ts does the same from the PDFs themselves, but needs the
 * PDF folder, `pdftotext` and `tsx` — none of which a production host has. The
 * PDFs' chunks are already in the index, so this rebuilds each document from
 * them and runs the same extraction. Compiles into dist/ with the server.
 *
 *   npm run curriculum:templates            # preview: lists the documents found
 *   npm run curriculum:templates -- --apply # extract (one LLM call per PDF) + save
 *
 * Safe to re-run. A document whose extraction fails keeps its previous template.
 */
import { connectDatabase, disconnectDatabase } from "../database/connect.js";
import { extractTemplate, saveTemplates, type Template } from "../rag/curriculum.js";
import { documentsByPrefix } from "../rag/pinecone.js";

const APPLY = process.argv.includes("--apply");
const PREFIX = process.argv.find((a) => a.startsWith("--prefix="))?.slice("--prefix=".length) ?? "Lesson-PDFs/";
const CONCURRENCY = 4;

async function main() {
  const docs = await documentsByPrefix(PREFIX);
  console.log(`Found ${docs.size} documents under "${PREFIX}" in the index.`);
  for (const [path, text] of docs) console.log(`  ${path} (${text.length} chars)`);
  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to extract and save the templates.");
    return;
  }
  if (docs.size === 0) {
    console.error("Nothing to do: no documents found. Check PINECONE_* and the prefix.");
    process.exitCode = 1;
    return;
  }

  await connectDatabase();
  try {
    const entries = [...docs];
    const templates: Template[] = [];
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const batch = entries.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(([path, text]) => extractTemplate(text, path)));
      results.forEach((r, j) => {
        const path = batch[j]![0];
        if (r.status === "fulfilled") {
          templates.push(r.value);
          console.log(`  ${path} → ${r.value.kind} "${r.value.skill}" (${r.value.courses.length} course(s))`);
        } else {
          console.warn(`  ${path} FAILED: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
        }
      });
    }
    // Pruning only when every document succeeded, so a failed extraction never
    // deletes a good template from an earlier run.
    await saveTemplates(templates, { prune: templates.length === entries.length });
    console.log(`\nSaved ${templates.length} of ${entries.length} templates.`);
    if (templates.length < entries.length) process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
