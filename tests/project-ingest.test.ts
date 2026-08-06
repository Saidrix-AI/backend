import AdmZip from "adm-zip";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  applyCaps,
  isIgnored,
  languageOf,
  shouldReview,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from "../src/agents/project-reviewer/filter.js";
import { parseRepoUrl } from "../src/agents/project-reviewer/github.js";
import { buildFileTree, applyBadges } from "../src/agents/project-reviewer/tree.js";
import { commonRootDir, ingestFromZip, isUnsafeEntryName } from "../src/agents/project-reviewer/zip.js";

describe("filter", () => {
  it("maps source extensions to languages and ignores the rest", () => {
    expect(languageOf("src/app.py")).toBe("python");
    expect(languageOf("src/App.tsx")).toBe("typescript");
    expect(languageOf("main.GO")).toBe("go");
    expect(languageOf("logo.png")).toBe("");
    expect(languageOf("README.md")).toBe("");
  });

  /**
   * These used to fall through to "" and render as "wasn't reviewed" even
   * though they are the student's own code, not documentation or a binary — an
   * Android submission's manifest, layouts and build script were silently
   * skipped in full. package-lock.json is the control: still excluded, but via
   * DENY_FILES (generated), not because .json itself is unreviewable.
   */
  it("reviews structured config formats a student actually writes", () => {
    expect(languageOf("AndroidManifest.xml")).toBe("xml");
    expect(languageOf("res/values/strings.xml")).toBe("xml");
    expect(languageOf("build.gradle")).toBe("gradle");
    expect(languageOf("settings.gradle")).toBe("gradle");
    expect(languageOf("build.gradle.kts")).toBe("kotlin");
    expect(languageOf("package.json")).toBe("json");
    expect(languageOf("docker-compose.yml")).toBe("yaml");
    expect(languageOf("config.yaml")).toBe("yaml");
    expect(languageOf("Cargo.toml")).toBe("toml");

    expect(shouldReview("package-lock.json")).toBe(false);
  });

  /**
   * Filenames with no dot to key on (Dockerfile, Makefile) or a dot that
   * belongs to a generic suffix (CMakeLists.txt) are matched by exact
   * lowercased basename instead of extension. Podfile and Gemfile are real
   * Ruby DSLs a student can get wrong — Podfile especially, the dependency
   * manifest for most iOS submissions — so "no extension" must not mean
   * "not code" for these.
   */
  it("reviews conventional extensionless build/dependency files by name", () => {
    expect(languageOf("Dockerfile")).toBe("dockerfile");
    expect(languageOf("backend/Dockerfile")).toBe("dockerfile");
    expect(languageOf("api.dockerfile")).toBe("dockerfile");
    expect(languageOf("Makefile")).toBe("make");
    expect(languageOf("GNUmakefile")).toBe("make");
    expect(languageOf("CMakeLists.txt")).toBe("cmake");
    expect(languageOf("ios/Podfile")).toBe("ruby");
    expect(languageOf("Gemfile")).toBe("ruby");
    expect(languageOf("Jenkinsfile")).toBe("groovy");
  });

  /**
   * A spread across the platform's real course scope: mobile (Objective-C,
   * F#-shaped shader-adjacent ambiguity aside), data/ML notebooks, functional
   * languages taught in CS coursework, and infra-as-code. Cross-checked
   * against GitHub Linguist's extension table rather than guessed.
   */
  it("reviews a broad spread of real source formats across mobile, data/ML, functional and devops", () => {
    expect(languageOf("notebook.ipynb")).toBe("jupyter");
    expect(languageOf("analysis.R")).toBe("r");
    expect(languageOf("report.Rmd")).toBe("rmarkdown");
    expect(languageOf("Main.hs")).toBe("haskell");
    expect(languageOf("lib/parser.ex")).toBe("elixir");
    expect(languageOf("src/App.svelte")).toBe("svelte");
    expect(languageOf("infra/main.tf")).toBe("terraform");
    expect(languageOf("prisma/schema.prisma")).toBe("prisma");
    expect(languageOf("proto/types.proto")).toBe("protobuf");
    expect(languageOf("scenes/Player.gd")).toBe("gdscript");
    expect(languageOf("Shaders/fx.hlsl")).toBe("hlsl");
    expect(languageOf("ios/ViewController.m")).toBe("objectivec");
  });

  /**
   * Widening .json/.yaml/.properties to real config a student writes means
   * those extensions would just as happily match a credential a student left
   * in the repo by accident. These stay unreviewed by NAME, regardless of what
   * their extension resolves to elsewhere in the map — never sent to the LLM,
   * and never shown as reviewable in the file tree's counts.
   */
  it("never reviews plausible secrets, whatever their extension", () => {
    expect(languageOf(".env")).toBe("");
    expect(languageOf(".env.production")).toBe("");
    expect(languageOf("credentials.json")).toBe("");
    expect(languageOf("config/serviceAccountKey.json")).toBe("");
    expect(languageOf("secrets.yaml")).toBe("");
    expect(languageOf("google-services.json")).toBe("");
    expect(languageOf("local.properties")).toBe("");
    expect(languageOf("certs/server.pem")).toBe("");
    expect(languageOf("private.key")).toBe("");
    expect(languageOf("id_rsa")).toBe("");

    expect(isIgnored(".env")).toBe(true);
    expect(isIgnored("credentials.json")).toBe(true);
    expect(shouldReview("secrets.yaml")).toBe(false);

    // Ordinary config with no sensitive name in the same formats still reviews.
    expect(languageOf("app.properties")).toBe("properties");
    expect(languageOf("config.yaml")).toBe("yaml");
  });

  it("ignores a lock file regardless of how the original repo cased its name", () => {
    // DENY_FILES used to hold "Pipfile.lock" verbatim while the lookup
    // lowercased the incoming name first — a mixed-case Set entry can never
    // match a lowercased key, so this exclusion was silently dead.
    expect(isIgnored("Pipfile.lock")).toBe(true);
    expect(isIgnored("backend/Pipfile.lock")).toBe(true);
  });

  it("ignores build directories from iOS, Flutter, Elixir and Terraform toolchains", () => {
    expect(isIgnored("Pods/SomeLib/SomeLib.m")).toBe(true);
    expect(isIgnored("ios/DerivedData/x.swift")).toBe(true);
    expect(isIgnored(".dart_tool/package_config.json")).toBe(true);
    expect(isIgnored("_build/dev/lib/app.ex")).toBe(true);
    expect(isIgnored(".terraform/providers/x.tf")).toBe(true);
  });

  it("ignores dependency, build and tool directories at any depth", () => {
    expect(isIgnored("node_modules/react/index.js")).toBe(true);
    expect(isIgnored("frontend/node_modules/x/y.js")).toBe(true);
    expect(isIgnored("app/__pycache__/mod.pyc")).toBe(true);
    expect(isIgnored(".git/config")).toBe(true);
    expect(isIgnored("dist/bundle.js")).toBe(true);
    expect(isIgnored("src/app.py")).toBe(false);
  });

  it("does not ignore a file merely named like a denied directory", () => {
    expect(isIgnored("src/build.py")).toBe(false);
  });

  it("ignores lockfiles", () => {
    expect(isIgnored("package-lock.json")).toBe(true);
    expect(isIgnored("backend/poetry.lock")).toBe(true);
  });

  it("reviews only unignored source", () => {
    expect(shouldReview("src/app.py")).toBe(true);
    expect(shouldReview("node_modules/x/index.js")).toBe(false);
    expect(shouldReview("docs/guide.md")).toBe(false);
  });
});

describe("applyCaps", () => {
  const file = (path: string, content: string) => ({ path, content });

  it("keeps everything under the caps", () => {
    const result = applyCaps([file("a.py", "print(1)"), file("b.py", "print(2)")]);
    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it("stops at the file-count cap and reports truncation", () => {
    const many = Array.from({ length: MAX_FILES + 5 }, (_, i) => file(`f${i}.py`, "x"));
    const result = applyCaps(many);
    expect(result.files).toHaveLength(MAX_FILES);
    expect(result.truncated).toBe(true);
  });

  it("stops at the total-bytes cap", () => {
    const big = "x".repeat(MAX_FILE_BYTES);
    const many = Array.from({ length: 20 }, (_, i) => file(`f${i}.py`, big));
    const result = applyCaps(many);
    expect(result.files.length).toBeLessThan(20);
    expect(result.truncated).toBe(true);
    const total = result.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
  });

  it("skips a single oversized file but keeps reviewing the rest", () => {
    const result = applyCaps([
      file("huge.py", "x".repeat(MAX_FILE_BYTES + 1)),
      file("small.py", "print(1)"),
    ]);
    expect(result.files.map((f) => f.path)).toEqual(["small.py"]);
    expect(result.truncated).toBe(true);
  });
});

describe("parseRepoUrl", () => {
  it("accepts the forms students paste", () => {
    expect(parseRepoUrl("https://github.com/octocat/hello-world")).toEqual({ owner: "octocat", repo: "hello-world" });
    expect(parseRepoUrl("http://www.github.com/octocat/hello-world/")).toEqual({ owner: "octocat", repo: "hello-world" });
    expect(parseRepoUrl("github.com/octocat/hello-world.git")).toEqual({ owner: "octocat", repo: "hello-world" });
    expect(parseRepoUrl("  https://github.com/octocat/hello-world/tree/main/src  ")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it("rejects non-GitHub and malformed links with a 400", () => {
    for (const bad of ["", "not a url", "https://gitlab.com/a/b", "https://github.com/octocat"]) {
      expect(() => parseRepoUrl(bad)).toThrowError(expect.objectContaining({ statusCode: 400 }));
    }
  });
});

describe("zip safety", () => {
  it("flags traversing and absolute entry names", () => {
    expect(isUnsafeEntryName("../../etc/passwd")).toBe(true);
    expect(isUnsafeEntryName("proj/../../x.py")).toBe(true);
    expect(isUnsafeEntryName("/etc/passwd")).toBe(true);
    expect(isUnsafeEntryName("C:/windows/x.py")).toBe(true);
    expect(isUnsafeEntryName("proj\\..\\..\\x.py")).toBe(true);
    expect(isUnsafeEntryName("proj/src/app.py")).toBe(false);
  });

  it("finds the single wrapping directory, or none", () => {
    expect(commonRootDir(["proj/a.py", "proj/src/b.py"])).toBe("proj");
    expect(commonRootDir(["a.py", "src/b.py"])).toBe("");
    expect(commonRootDir([])).toBe("");
  });
});

function zipOf(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content, "utf8"));
  return zip.toBuffer();
}

/**
 * A single-entry zip built byte by byte. AdmZip.addFile sanitizes traversing
 * names as it writes ("../evil.py" → "evil.py"), so a hostile archive can only
 * be reproduced by hand — and adm-zip's reader does surface such a name as-is,
 * which is what ingestFromZip has to defend against.
 */
function handCraftedZip(name: string, content: string): Buffer {
  const n = Buffer.from(name, "utf8");
  const d = Buffer.from(content, "utf8");
  const crc = zlib.crc32(d);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0); // signature
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(d.length, 18); // compressed size (stored)
  localHeader.writeUInt32LE(d.length, 22); // uncompressed size
  localHeader.writeUInt16LE(n.length, 26);
  const local = Buffer.concat([localHeader, n, d]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4); // version made by
  centralHeader.writeUInt16LE(20, 6); // version needed
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(d.length, 20);
  centralHeader.writeUInt32LE(d.length, 24);
  centralHeader.writeUInt16LE(n.length, 28);
  const central = Buffer.concat([centralHeader, n]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);

  return Buffer.concat([local, central, eocd]);
}

describe("ingestFromZip", () => {
  it("strips the root dir, filters, and keeps non-source paths in the listing", () => {
    const result = ingestFromZip(
      zipOf({
        "my-proj/main.py": "print('hi')",
        "my-proj/README.md": "# hi",
        "my-proj/node_modules/dep/index.js": "module.exports={}",
        "my-proj/package-lock.json": "{}",
      }),
    );
    expect(result.rootName).toBe("my-proj");
    expect(result.files.map((f) => f.path)).toEqual(["main.py"]);
    expect(result.files[0]!.language).toBe("python");
    expect(result.files[0]!.content).toBe("print('hi')");
    expect(result.paths).toEqual(["main.py", "README.md"]);
    expect(result.truncated).toBe(false);
  });

  it("handles a zip with no wrapping directory", () => {
    const result = ingestFromZip(zipOf({ "main.py": "x=1", "util.py": "y=2" }), "upload");
    expect(result.rootName).toBe("upload");
    expect(result.files.map((f) => f.path)).toEqual(["main.py", "util.py"]);
  });

  it("rejects a hand-crafted traversing archive", () => {
    const evil = handCraftedZip("../../evil.py", "x=1");
    // Guard against the guard: adm-zip really does hand this name back.
    expect(new AdmZip(evil).getEntries()[0]!.entryName).toBe("../../evil.py");
    expect(() => ingestFromZip(evil)).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });

  it("rejects a non-zip buffer", () => {
    expect(() => ingestFromZip(Buffer.from("not a zip"))).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("rejects an archive with no reviewable source", () => {
    expect(() => ingestFromZip(zipOf({ "proj/README.md": "# hi", "proj/logo.png": "x" }))).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("does not decompress past the byte budget", () => {
    // A decompression bomb: highly compressible filler that is trivial to
    // upload and enormous to hold. applyCaps discards all of it, but it only
    // sees content that has ALREADY been decompressed — so the budget has to be
    // spent on the archive's declared sizes first, or the memory is taken
    // before anything gets to reject it. Measured at ~1.5 GB peak RSS from a
    // 1.2 MB archive before this was enforced.
    const filler = " ".repeat(4 * 1024 * 1024); // 4 MB each, 20x MAX_FILE_BYTES
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`proj/f${i}.js`] = filler;

    // Built before the baseline is taken: constructing the archive allocates
    // the filler too, and that is the test's cost, not the ingest's.
    const archive = zipOf(files);

    const rss = () => process.memoryUsage().rss;
    const before = rss();
    const result = ingestFromZip(archive);
    const growth = rss() - before;

    // Nothing survives the cap either way; the point is what it cost to find out.
    expect(result.files).toHaveLength(0);
    expect(result.truncated).toBe(true);
    // 48 MB of declared content, none of it affordable. Allow generous slack
    // for unrelated allocation — the failure mode this guards against is two
    // orders of magnitude larger, not a few MB.
    expect(growth).toBeLessThan(16 * 1024 * 1024);
  });

  it("still reads every file that fits the budget", () => {
    // The guard must not become a reason to silently skip normal submissions.
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`proj/f${i}.js`] = `const a${i} = ${i};`;
    const result = ingestFromZip(zipOf(files));
    expect(result.files).toHaveLength(5);
    expect(result.files[0]!.content).toBe("const a0 = 0;");
    expect(result.truncated).toBe(false);
  });
});

describe("buildFileTree", () => {
  it("nests paths with folders first, then files, each alphabetical", () => {
    const tree = buildFileTree(["main.py", "agents/planner.py", "agents/core/state.py", "README.md"]);
    expect(tree.map((n) => n.name)).toEqual(["agents", "main.py", "README.md"]);
    const agents = tree[0]!;
    expect(agents.type).toBe("folder");
    expect(agents.children!.map((n) => n.name)).toEqual(["core", "planner.py"]);
    expect(agents.children![0]!.children!.map((n) => n.name)).toEqual(["state.py"]);
  });

  it("badges files by full path", () => {
    const tree = applyBadges(
      buildFileTree(["agents/planner.py", "main.py"]),
      new Map([["agents/planner.py", 3]]),
    );
    expect(tree[0]!.children![0]!.badge).toBe(3);
    expect(tree[1]!.badge).toBeUndefined();
  });
});
