import type { SearchSource } from "../tools/web-search.js";

/**
 * The candidate machinery shared by the two blocks that put real links in front
 * of a student: the closing `resources` section (resources.ts) and the setup
 * lane's `downloads` section (downloads.ts).
 *
 * It lives here rather than in either module because the guarantee it exists to
 * provide — the student only ever clicks a URL that came back from OUR search,
 * never one a model typed — has to hold identically in both. Two copies of that
 * logic is two chances for one of them to drift.
 */

/**
 * Paid courses, paywalls and homework mills. Applied TWICE — as Tavily's
 * `exclude_domains` and again as a post-filter — because the first is a service
 * behaviour we do not control and the second is ours.
 */
export const PAID_COURSE_DOMAINS = [
  "udemy.com", "coursera.org", "edx.org", "udacity.com", "pluralsight.com",
  "datacamp.com", "codecademy.com", "skillshare.com", "masterclass.com",
  "lynda.com", "educative.io", "frontendmasters.com", "egghead.io",
  "laracasts.com", "zerotomastery.io", "teachable.com", "thinkific.com",
  "kajabi.com", "simplilearn.com", "mygreatlearning.com", "upgrad.com",
  "scaler.com", "brilliant.org", "linkedin.com",
  // Not courses, but the same outcome for the student — a wall instead of a page.
  "chegg.com", "coursehero.com", "studocu.com", "scribd.com", "quizlet.com",
  // Metered paywalls: "you have 1 free article left" is not a free resource.
  "medium.com", "towardsdatascience.com",
] as const;

/** Snippet shown per candidate. Enough to judge relevance, not enough to bloat. */
export const SNIPPET_CHARS = 200;
/** A dead link is worse than a missing one, but not worth a long wait. */
const HEAD_TIMEOUT_MS = 3000;

/** Query params that identify the referrer rather than the page. */
const TRACKING_PARAMS = /^(utm_|ref$|ref_|fbclid$|gclid$|mc_|si$|feature$|pp$)/i;

export interface LinkCandidate {
  title: string;
  url: string;
  domain: string;
  snippet: string;
}

/**
 * Registrable-suffix match, not `includes()`: `includes` would clear
 * `notudemy.com` and miss nothing useful, while this correctly rejects both
 * `www.udemy.com` and `blog.udemy.com` and leaves `myudemy.org` alone.
 */
export function matchesDomain(url: string, blocked: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true; // unparseable is not shippable
  }
  return blocked.some((d) => host === d || host.endsWith(`.${d}`));
}

/** The resources section's blocklist, kept as a named export for its callers. */
export function isBlockedUrl(url: string): boolean {
  return matchesDomain(url, PAID_COURSE_DOMAINS);
}

/** Drops tracking params and the fragment, so two spellings of a page dedupe. */
export function canonicalize(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * A search result turned into a candidate, or null when it is unusable.
 * `blocked` is the caller's own blocklist — the two sections reject different
 * things (a paywalled tutorial vs. an installer mirror).
 */
export function toCandidate(s: SearchSource, blocked: readonly string[]): LinkCandidate | null {
  const url = canonicalize(s.url ?? "");
  if (!url || matchesDomain(url, blocked)) return null;
  const title = (s.title ?? "").replace(/\s+/g, " ").trim();
  if (!title) return null;
  return {
    title: title.slice(0, 140),
    url,
    domain: hostOf(url),
    snippet: (s.content ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS),
  };
}

/** Dedupes by canonical url, preserving search rank. */
export function dedupe(list: LinkCandidate[], seen: Set<string>, cap: number): LinkCandidate[] {
  const out: LinkCandidate[] = [];
  for (const c of list) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Drops links the web says are gone. Anything that merely ERRORS is kept: a CDN
 * refusing HEAD, or a host that times out once, is not a dead link, and
 * dropping it would quietly empty the section on perfectly good sites.
 */
export async function keepLive(candidates: LinkCandidate[]): Promise<LinkCandidate[]> {
  const checks = await Promise.all(
    candidates.map(async (c) => {
      try {
        const res = await fetch(c.url, {
          method: "HEAD",
          redirect: "follow",
          signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
        });
        return res.status < 400;
      } catch {
        return true;
      }
    }),
  );
  return candidates.filter((_, i) => checks[i]);
}

export interface NumberedPick {
  number: number;
  why: string;
}

/** Reads a pick loosely — the model's own url/title fields are ignored on purpose. */
export function readPick(raw: unknown): NumberedPick | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { number?: unknown; why?: unknown };
  const number = typeof o.number === "number" ? o.number : Number(o.number);
  const why = typeof o.why === "string" ? o.why.replace(/\s+/g, " ").trim() : "";
  if (!Number.isInteger(number) || !why) return null;
  return { number, why: why.slice(0, 220) };
}

/** Renders candidates as the numbered list the picker prompts hand to the model. */
export function numberedList(items: LinkCandidate[]): string[] {
  return items.map((c, i) => `[${i + 1}] ${c.title} — ${c.domain}${c.snippet ? `\n    ${c.snippet}` : ""}`);
}
