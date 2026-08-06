/**
 * What of a submitted project is worth an LLM's attention. Both ingest paths
 * (github.ts, zip.ts) narrow with the same rules so a repo and the same code
 * uploaded as a folder produce the same review.
 *
 * The extension list is deliberately scoped to what a student on THIS
 * platform's catalog actually writes — web, mobile, backend, data/ML, devops
 * — cross-checked against GitHub Linguist's canonical extension→language
 * table (github-linguist/linguist, lib/linguist/languages.yml) rather than
 * guessed. Legacy/hardware-description/esoteric languages (COBOL, Fortran,
 * VHDL, Assembly, Visual Basic 6, …) are left out on purpose: they don't
 * appear in this platform's courses, and every extension added is another
 * chance to collide with something that does (see the ambiguity notes below).
 */

/** Directory names that are never a student's own work. */
const DENY_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "vendor",
  "coverage",
  ".idea",
  ".vscode",
  ".cache",
  ".gradle",
  "bin",
  "obj",
  // iOS / Swift package manager.
  "pods",
  "deriveddata",
  ".build",
  // Flutter / Dart.
  ".dart_tool",
  ".pub-cache",
  // Elixir.
  "_build",
  "deps",
  // Terraform.
  ".terraform",
  // Frontend build caches.
  ".angular",
  ".nx",
  ".turbo",
  ".parcel-cache",
  ".expo",
  // CMake out-of-source build dirs.
  "cmake-build-debug",
  "cmake-build-release",
]);

/** Generated/lock files: large, machine-written, nothing to review. */
const DENY_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pipfile.lock",
  "composer.lock",
  "cargo.lock",
  "go.sum",
  "gemfile.lock",
  "mix.lock",
  ".ds_store",
]);

/**
 * Filenames worth reviewing that carry no extension `ext()` can key on —
 * either no dot at all (Dockerfile, Makefile) or a dot that belongs to a
 * generic suffix (CMakeLists.txt). Checked by exact lowercased basename.
 *
 * Several of these (Vagrantfile, Rakefile, Gemfile, Podfile) are full Ruby
 * DSLs a student can genuinely get wrong — treating them as "not code" would
 * skip real bugs, especially Podfile, which is the dependency manifest for
 * most student iOS submissions.
 */
const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "make",
  gnumakefile: "make",
  bsdmakefile: "make",
  "cmakelists.txt": "cmake",
  vagrantfile: "ruby",
  rakefile: "ruby",
  gemfile: "ruby",
  podfile: "ruby",
  brewfile: "ruby",
  jenkinsfile: "groovy",
};

/**
 * Filenames that are common sources of live secrets. Never reviewed,
 * regardless of what their extension would otherwise resolve to — the
 * `json`/`yaml`/`properties` entries below are needed for real config a
 * student wrote, and without this list they would just as happily match a
 * service-account key or a credentials dump a student left in the repo by
 * mistake. Checked against the basename only, case-insensitively.
 */
const SENSITIVE_FILENAME_PATTERN =
  /^(\.env(\..+)?|id_rsa|id_dsa|id_ecdsa|id_ed25519|\.npmrc|\.netrc|\.pgpass|local\.properties|google-services\.json)$|credentials.*\.(json|ya?ml)$|.*service[-_]?account.*\.json$|.*secrets.*\.(json|ya?ml)$|firebase-adminsdk.*\.json$/i;

/** Extensions that are always a private key or certificate, never source. */
const SENSITIVE_EXTENSIONS = new Set(["pem", "key", "crt", "cer", "p12", "pfx", "jks", "keystore"]);

/** Source extension → the language label the report and the workers use. */
const LANGUAGES: Record<string, string> = {
  // --- Web / general purpose -------------------------------------------
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  cts: "typescript",
  mts: "typescript",
  java: "java",
  go: "go",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  rs: "rust",
  scala: "scala",
  groovy: "groovy",
  sh: "bash",
  bash: "bash",
  ps1: "powershell",
  bat: "batchfile",
  cmd: "batchfile",
  sql: "sql",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  styl: "css",

  // --- Mobile -------------------------------------------------------------
  kt: "kotlin",
  kts: "kotlin", // Gradle Kotlin DSL (build.gradle.kts) and standalone .kts scripts.
  swift: "swift",
  dart: "dart",
  // .m is a three-way clash across Linguist (Objective-C / MATLAB / Mercury).
  // Objective-C is overwhelmingly the more likely source on a coding-course
  // platform, so that is the label used — an LLM reviewing a MATLAB file
  // mislabelled this way still reviews the actual content correctly, since
  // the label is prompt context, not an enforced grammar.
  m: "objectivec",
  mm: "objectivecpp",

  // --- Functional / JVM-and-friends, common in CS coursework --------------
  hs: "haskell",
  ml: "ocaml",
  mli: "ocaml",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hrl: "erlang",
  // Plain .fs also names a GLSL fragment-shader stage file; F# is the far
  // more likely match for this platform's coursework, and the ambiguity is
  // harmless for the same reason .m is: only the label, not the review, would
  // be affected by a wrong guess.
  fs: "fsharp",
  fsi: "fsharp",
  fsx: "fsharp",
  elm: "elm",
  purs: "purescript",
  cr: "crystal",
  nim: "nim",
  zig: "zig",
  jl: "julia",
  lua: "lua",
  pl: "perl", // Also Prolog's extension; Perl is the far more common submission.
  pm: "perl",

  // --- Data science / ML ---------------------------------------------------
  ipynb: "jupyter", // Raw content is JSON (cells of code+markdown+output) — passed through as-is.
  r: "r",
  rmd: "rmarkdown",

  // --- Web frameworks / templating -----------------------------------------
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  hbs: "handlebars",
  handlebars: "handlebars",
  ejs: "ejs",
  pug: "pug",
  jade: "pug",
  haml: "haml",
  liquid: "liquid",
  twig: "twig",

  // --- Structured config the student actually wrote — not "documentation,
  // data and binary" in the sense the empty-file message warns about. An
  // Android submission's manifest, layouts and Gradle scripts are as much
  // the project as its .java, and used to render as silently "wasn't
  // reviewed" with no indication that was ever going to happen. Any of these
  // that commonly carries live secrets (service-account keys, credential
  // dumps) is still excluded by name — see SENSITIVE_FILENAME_PATTERN.
  xml: "xml",
  gradle: "gradle",
  json: "json", // package.json, tsconfig.json — package-lock.json etc. stay excluded via DENY_FILES.
  json5: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml", // Cargo.toml, pyproject.toml.
  ini: "ini",
  cfg: "ini",
  conf: "conf",
  properties: "properties", // application.properties, gradle.properties — local.properties stays excluded (see above).

  // --- DevOps / infra-as-code -----------------------------------------------
  tf: "terraform",
  tfvars: "terraform",
  hcl: "hcl",
  dockerfile: "dockerfile", // e.g. "app.dockerfile" — the extensionless "Dockerfile" is in FILENAME_LANGUAGES.
  cmake: "cmake",
  proto: "protobuf",
  graphql: "graphql",
  gql: "graphql",
  prisma: "prisma",

  // --- Game dev -------------------------------------------------------------
  gd: "gdscript",
  shader: "shaderlab",
  hlsl: "hlsl",
  cginc: "hlsl",
  glsl: "glsl",
  frag: "glsl",
  vert: "glsl",
  comp: "glsl",
};

export const MAX_FILES = 100;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
/** Beyond this a single file is machine-generated or a data dump, not code. */
export const MAX_FILE_BYTES = 200 * 1024;

export interface SourceFile {
  path: string;
  language: string;
  content: string;
}

function basename(path: string): string {
  return path.split("/").pop() ?? "";
}

function ext(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The language label for a path, or "" when it is not source we review. */
export function languageOf(path: string): string {
  if (isSensitive(path)) return "";
  const name = basename(path).toLowerCase();
  return FILENAME_LANGUAGES[name] ?? LANGUAGES[ext(path)] ?? "";
}

/** True when the filename is a plausible secret regardless of extension. */
function isSensitive(path: string): boolean {
  const name = basename(path);
  return SENSITIVE_FILENAME_PATTERN.test(name) || SENSITIVE_EXTENSIONS.has(ext(path));
}

/** True when the path is inside a denied directory or is a denied file. */
export function isIgnored(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  if (parts.slice(0, -1).some((dir) => DENY_DIRS.has(dir.toLowerCase()))) return true;
  if (DENY_FILES.has(name.toLowerCase())) return true;
  return isSensitive(path);
}

/**
 * True when the file should be sent to a review worker: not ignored, and a
 * language we can review. Files that fail this still appear in the file tree —
 * seeing them is part of understanding the project.
 */
export function shouldReview(path: string): boolean {
  return !isIgnored(path) && languageOf(path) !== "";
}

/**
 * Caps the reviewed set so one huge submission cannot run up an unbounded LLM
 * bill. Order is preserved (the caller's directory order), and the caller
 * reports `truncated` to the student rather than failing the review.
 */
export function applyCaps<T extends { path: string; content: string }>(
  files: T[],
): { files: T[]; truncated: boolean } {
  const kept: T[] = [];
  let total = 0;
  let truncated = false;

  for (const file of files) {
    const size = Buffer.byteLength(file.content, "utf8");
    if (size > MAX_FILE_BYTES) {
      truncated = true;
      continue;
    }
    if (kept.length >= MAX_FILES || total + size > MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    kept.push(file);
    total += size;
  }
  return { files: kept, truncated };
}
