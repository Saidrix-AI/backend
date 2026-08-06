import { BRAND_ICON_NAMES, type COURSE_ICON_NAMES } from "../validation/course.schema.js";

type IconName = (typeof COURSE_ICON_NAMES)[number];

const BRANDS = new Set<string>(BRAND_ICON_NAMES);

/**
 * Title keywords → icon name, in priority order.
 *
 * ORDER IS LOAD-BEARING. "JavaScript" contains "java", "TypeScript" contains
 * "script", "React Native" contains "react" — the first match wins, so the more
 * specific pattern must come first. Patterns are matched against a lowercased
 * title (+ description), so they are written lowercase.
 *
 * Deliberately conservative: a rule only fires when the text really names the
 * technology. A missed inference leaves the model's own choice in place, which
 * is a far better failure than confidently stamping the wrong logo on a course.
 */
const RULES: ReadonlyArray<readonly [RegExp, IconName]> = [
  // --- "<name>.js" frameworks, before any language rule ---
  // `.` is a word boundary, so the bare `\bjs\b` fallback below would otherwise
  // claim "Next.js" and "Node.js" for JavaScript.
  [/\bnext\.?js\b/, "nextjs"],
  [/\bnode\.?js\b/, "node"],

  // --- Languages (specific-before-general) ---
  [/\btypescript\b|\bts\b(?!\w)/, "typescript"],
  [/\bjavascript\b|\bes6\b|\bvanilla js\b|\bjs\b(?!\w)/, "javascript"],
  [/\bpython\b|\bpy\b(?!\w)/, "python"],
  [/\bc\+\+\b|\bcpp\b/, "cpp"],
  [/\bc#\b|\bc sharp\b|\bcsharp\b|\b\.net\b|\bdotnet\b/, "csharp"],
  [/\bjava\b(?!script)/, "java"],
  [/\bkotlin\b/, "kotlin"],
  [/\bswift\b|\bios\b/, "swift"],
  [/\bgolang\b|\bgo (programming|language)\b/, "go"],
  [/\brust\b/, "rust"],
  [/\bphp\b/, "php"],
  [/\bruby\b|\brails\b/, "ruby"],
  [/\bdart\b/, "dart"],

  // --- Frameworks & frontend (the .js ones are handled at the top) ---
  [/\breact\b/, "react"],
  [/\bvue\b/, "vue"],
  [/\bangular\b/, "angular"],
  [/\bsvelte\b/, "svelte"],
  [/\bflutter\b/, "flutter"],
  [/\bexpress\b/, "express"],
  [/\bdjango\b/, "django"],
  [/\bflask\b/, "flask"],
  [/\bspring\b/, "spring"],
  [/\blaravel\b/, "laravel"],
  [/\bgraphql\b/, "graphql"],
  [/\btailwind\b/, "tailwind"],
  [/\bbootstrap\b/, "bootstrap"],
  [/\bhtml\b/, "html"],
  [/\bcss\b|\bflexbox\b/, "css"],
  [/\bfigma\b|\bui\/ux\b|\bux design\b/, "figma"],
  [/\bunity\b|\bgame dev/, "unity"],

  // --- Data stores & infra ---
  [/\bpostgres(ql)?\b/, "postgres"],
  [/\bmysql\b/, "mysql"],
  [/\bmongo(db)?\b/, "mongodb"],
  [/\bsqlite\b/, "sqlite"],
  [/\bredis\b/, "redis"],
  [/\bfirebase\b/, "firebase"],
  [/\bsupabase\b/, "supabase"],
  [/\bkubernetes\b|\bk8s\b/, "kubernetes"],
  [/\bdocker\b|\bcontainer/, "docker"],
  [/\bgithub\b/, "github"],
  [/\bgit\b/, "git"],
  [/\blinux\b|\bbash\b|\bshell script/, "linux"],

  // --- ML / data stack ---
  [/\btensorflow\b/, "tensorflow"],
  [/\bpytorch\b/, "pytorch"],
  [/\bscikit|\bsklearn\b/, "sklearn"],
  [/\bpandas\b/, "pandas"],
  [/\bnumpy\b/, "numpy"],
  [/\bjupyter\b|\bnotebook\b/, "jupyter"],

  // --- Subjects with no brand mark: a contextual generic beats a default ---
  [/\bsql\b|\bdatabase\b|\bdata modell?ing\b|\bquery\b/, "database"],
  [/\bmachine learning\b|\bdeep learning\b|\bneural\b|\bml\b(?!\w)|\bai\b(?!\w)/, "brain"],
  [/\bdata (analysis|analytics|science|visuali[sz]ation)\b|\bstatistics\b|\banalytics\b/, "chart"],
  [/\balgorithm|\bdata structure|\bleetcode\b|\bcompetitive programming\b/, "code"],
  [/\bagent\b|\bllm\b|\bchatbot\b|\bprompt engineering\b/, "robot"],
  [/\bweb (dev|development)\b|\bfrontend\b|\bfull.?stack\b|\bhttp\b|\brest api\b/, "globe"],
  [/\bcloud\b|\baws\b|\bazure\b|\bgcp\b/, "cloud"],
  [/\bsecurity\b|\bcyber\b|\bcryptograph|\bauth(entication)?\b/, "lock"],
  [/\bsystem design\b|\barchitecture\b|\bmicroservice/, "layers"],
  [/\bdevops\b|\bci\/cd\b|\bdeployment\b/, "settings"],
  [/\bnetwork|\boperating system\b|\bcomputer architecture\b/, "cpu"],
];

/** First matching rule for the given text, or null when nothing is confident. */
export function inferIcon(text: string): IconName | null {
  const haystack = text.toLowerCase();
  for (const [pattern, icon] of RULES) {
    if (pattern.test(haystack)) return icon;
  }
  return null;
}

/**
 * The icon a course/project should carry, given what the model chose.
 *
 * A brand mark the model picked deliberately always wins — inference is a safety
 * net for the far more common case where it fell back to a vague generic like
 * "book" on a course plainly titled "React Fundamentals".
 */
export function refineIcon(modelIcon: string | undefined, ...text: (string | undefined)[]): string {
  const current = modelIcon || "book";
  if (BRANDS.has(current)) return current;
  return inferIcon(text.filter(Boolean).join(" ")) ?? current;
}
