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

/** A submission's source plus everything else the student's repo/folder holds. */
export interface IngestedProject {
  /** Files sent to review workers — filtered, capped, contents loaded. */
  files: SourceFile[];
  /** Every non-ignored path, reviewed or not — what the Files panel shows. */
  paths: string[];
  truncated: boolean;
  /** Repo/folder name, used as the tree's root label. */
  rootName: string;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

const GITHUB_API = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";
const BLOB_CONCURRENCY = 8;

/**
 * Accepts the forms a student actually pastes: with or without protocol/www,
 * a trailing .git, or a deep link (/tree/main/src). Anything else is rejected
 * here rather than becoming a confusing 404 later.
 */
export function parseRepoUrl(input: string): RepoRef {
  const trimmed = input.trim();
  // `?` and `#` are excluded from the owner as well as the repo: they are not
  // legal in a GitHub username, and leaving them in let a crafted link graft a
  // query string or fragment onto the API URL built below.
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)/i.exec(trimmed);
  if (!match) {
    throw new ApiError(400, "That doesn't look like a GitHub repository link (expected https://github.com/owner/repo).");
  }
  const owner = match[1]!;
  const repo = match[2]!.replace(/\.git$/i, "");
  if (!owner || !repo) {
    throw new ApiError(400, "That GitHub link is missing an owner or repository name.");
  }
  return { owner, repo };
}

async function githubJson<T>(url: string, notFoundMessage: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "saidrix-project-reviewer" },
  });

  if (res.status === 404) throw new ApiError(400, notFoundMessage);
  if (res.status === 403 || res.status === 429) {
    throw new ApiError(429, "GitHub is rate-limiting us right now. Please try again in a few minutes.");
  }
  if (!res.ok) {
    throw new ApiError(502, `GitHub request failed (${res.status}). Please try again.`);
  }
  return (await res.json()) as T;
}

/** Fetches a public repo's reviewable source at its default branch. */
export async function ingestFromGithub(url: string): Promise<IngestedProject> {
  const { owner, repo } = parseRepoUrl(url);
  // Encoded before interpolation. Unencoded, an owner of ".." normalises the
  // path away and points the request at a different GitHub API endpoint than the
  // one this code believes it is calling.
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);

  const meta = await githubJson<{ default_branch?: string }>(
    `${GITHUB_API}/repos/${o}/${r}`,
    `We couldn't reach github.com/${owner}/${repo}. Check the link and make sure the repository is public.`,
  );
  const branch = meta.default_branch ?? "main";

  const tree = await githubJson<{ tree?: Array<{ path?: string; type?: string; size?: number }>; truncated?: boolean }>(
    `${GITHUB_API}/repos/${o}/${r}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    `The ${branch} branch of ${owner}/${repo} could not be read.`,
  );

  const blobs = (tree.tree ?? []).filter((e) => e.type === "blob" && e.path);
  const paths = blobs.map((e) => e.path!).filter((p) => !isIgnored(p));
  if (paths.length === 0) {
    throw new ApiError(400, `${owner}/${repo} looks empty — there are no files to review.`);
  }

  const reviewable = blobs.filter((e) => !isIgnored(e.path!) && shouldReview(e.path!));
  if (reviewable.length === 0) {
    throw new ApiError(400, `We found no source files we can review in ${owner}/${repo}.`);
  }

  // Spend the byte budget on the tree's declared sizes before fetching, for the
  // same reason the zip ingest does it: applyCaps runs on content that has
  // already been downloaded and held in memory, so on its own it bounds what
  // gets reviewed rather than what gets read. A repo of large source files
  // would be pulled in full and then thrown away.
  const affordable: string[] = [];
  let declaredTotal = 0;
  let skippedForSize = false;
  for (const blob of reviewable) {
    // Absent size means the API did not report one; treat it as reviewable and
    // let applyCaps be the backstop rather than dropping a real file.
    const declared = blob.size ?? 0;
    if (declared > MAX_FILE_BYTES) {
      skippedForSize = true;
      continue;
    }
    if (affordable.length >= MAX_FILES || declaredTotal + declared > MAX_TOTAL_BYTES) {
      skippedForSize = true;
      break;
    }
    affordable.push(blob.path!);
    declaredTotal += declared;
  }

  const contents = await fetchBlobs(owner, repo, branch, affordable);
  const { files, truncated } = applyCaps(contents);

  return {
    files,
    paths,
    // The API caps its own recursive tree listing; say so rather than pretend.
    truncated: truncated || skippedForSize || tree.truncated === true,
    rootName: repo,
  };
}

/** Raw-content fetches, bounded so a 100-file repo doesn't open 100 sockets. */
async function fetchBlobs(owner: string, repo: string, branch: string, paths: string[]): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  const queue = [...paths];

  const workers = Array.from({ length: Math.min(BLOB_CONCURRENCY, queue.length) }, async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const res = await fetch(`${RAW_BASE}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${encoded}`, {
        headers: { "User-Agent": "saidrix-project-reviewer" },
      });
      // A file that vanished between listing and fetching is not worth failing
      // the whole review over.
      if (!res.ok) continue;
      out.push({ path, language: languageOf(path), content: await res.text() });
    }
  });
  await Promise.all(workers);

  // Restore the caller's order — concurrent workers finish out of order, and
  // applyCaps keeps whatever comes first.
  const rank = new Map(paths.map((p, i) => [p, i]));
  out.sort((a, b) => (rank.get(a.path) ?? 0) - (rank.get(b.path) ?? 0));
  return out;
}
