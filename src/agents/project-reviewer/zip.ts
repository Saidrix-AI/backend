import AdmZip from "adm-zip";
import { ApiError } from "../../utils/apiError.js";
import {
  applyCaps,
  isIgnored,
  languageOf,
  shouldReview,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  type SourceFile,
} from "./filter.js";
import type { IngestedProject } from "./github.js";

/**
 * Zip entry names are attacker-controlled. We never write to disk, but a
 * traversing name would still poison the paths shown in the report, so they
 * are rejected outright rather than sanitized into something plausible.
 */
export function isUnsafeEntryName(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return true;
  if (/^[a-zA-Z]:/.test(normalized)) return true;
  return normalized.split("/").includes("..");
}

/**
 * The single wrapping directory a zipped folder always has ("my-project/src/…"
 * → "src/…"). Returns "" when entries do not share one root.
 */
export function commonRootDir(paths: string[]): string {
  if (paths.length === 0) return "";
  const first = paths[0]!.split("/")[0]!;
  if (!paths.every((p) => p.startsWith(`${first}/`))) return "";
  return first;
}

/** Reads an uploaded project zip into the same shape as a GitHub ingest. */
export function ingestFromZip(buffer: Buffer, fallbackName = "project"): IngestedProject {
  let entries: AdmZip.IZipEntry[];
  try {
    entries = new AdmZip(buffer).getEntries();
  } catch {
    throw new ApiError(400, "That file could not be read as a zip archive.");
  }

  const fileEntries = entries.filter((e) => !e.isDirectory);
  for (const entry of fileEntries) {
    if (isUnsafeEntryName(entry.entryName)) {
      throw new ApiError(400, "That archive contains unsafe file paths and was rejected.");
    }
  }

  const normalized = fileEntries.map((entry) => ({
    entry,
    path: entry.entryName.replace(/\\/g, "/").replace(/^\.\//, ""),
  }));

  const root = commonRootDir(normalized.map((n) => n.path));
  const stripped = normalized.map((n) => ({
    entry: n.entry,
    path: root ? n.path.slice(root.length + 1) : n.path,
  }));

  const kept = stripped.filter((n) => n.path && !isIgnored(n.path));
  if (kept.length === 0) {
    throw new ApiError(400, "That archive has no files to review.");
  }

  const reviewable = kept.filter((n) => shouldReview(n.path));
  if (reviewable.length === 0) {
    throw new ApiError(400, "We found no source files we can review in that archive.");
  }

  // Spend the byte budget on the DECLARED sizes before decompressing anything.
  //
  // applyCaps runs on already-materialised content, so on its own it is a cap
  // on what gets reviewed, not on what gets read: `getData()` on every
  // reviewable entry would run first and hold all of it in memory at once. A
  // 1.2 MB archive of compressible filler measured at 1.5 GB peak RSS that way,
  // every byte of it then discarded by the 2 MB cap — and multer accepts 25 MB,
  // so a single upload could ask for far more memory than the process has.
  //
  // The central directory's size field is a trustworthy bound: adm-zip inflates
  // with `maxOutputLength` set to it, so a lying header cannot over-expand (it
  // fails the CRC check instead).
  const affordable: typeof reviewable = [];
  let declaredTotal = 0;
  let skippedForSize = false;
  for (const n of reviewable) {
    const declared = n.entry.header.size;
    if (declared > MAX_FILE_BYTES) {
      skippedForSize = true;
      continue;
    }
    if (affordable.length >= MAX_FILES || declaredTotal + declared > MAX_TOTAL_BYTES) {
      skippedForSize = true;
      break;
    }
    affordable.push(n);
    declaredTotal += declared;
  }

  const contents: SourceFile[] = affordable.map((n) => ({
    path: n.path,
    language: languageOf(n.path),
    content: n.entry.getData().toString("utf8"),
  }));
  const { files, truncated } = applyCaps(contents);

  return {
    files,
    paths: kept.map((n) => n.path),
    truncated: truncated || skippedForSize,
    rootName: root || fallbackName,
  };
}
