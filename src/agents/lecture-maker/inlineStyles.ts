/**
 * Folds an SVG's `<style>` block into inline `style` attributes.
 *
 * Writing CSS classes is how models naturally draw SVG, and gpt-4o does it on
 * most attempts — but a `<style>` element inside inline SVG is NOT scoped: its
 * rules apply to the whole page, so a lecture could restyle the entire app.
 * Both the validator and the frontend sanitizer therefore reject it, which used
 * to throw away a finished (and expensive) drawing over pure syntax.
 *
 * Inlining first turns that failure into a success. Only simple selectors are
 * supported — `.class`, `#id`, `tag`, and comma-separated lists of those.
 * Anything more complex is left alone and still reported by the validator, so
 * the model gets a repair round rather than a silently mis-rendered diagram.
 */

interface Rule {
  selectors: string[];
  declarations: string;
}

const SIMPLE_SELECTOR = /^[.#]?[A-Za-z][\w-]*$/;

/** Splits a stylesheet into rules, dropping comments and at-rules. */
function parseRules(css: string): { rules: Rule[]; unsupported: boolean } {
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let unsupported = false;

  for (const match of cleaned.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorText = match[1]!.trim();
    const declarations = match[2]!.trim();
    if (!declarations) continue;
    // @media / @keyframes and friends carry nested blocks this parser can't fold.
    if (selectorText.startsWith("@")) {
      unsupported = true;
      continue;
    }
    const selectors = selectorText.split(",").map((s) => s.trim());
    if (selectors.some((s) => !SIMPLE_SELECTOR.test(s))) {
      unsupported = true;
      continue;
    }
    rules.push({ selectors, declarations });
  }
  return { rules, unsupported };
}

function attrValue(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? m[1]! : null;
}

function matches(tag: string, tagName: string, selector: string): boolean {
  if (selector.startsWith(".")) {
    const classes = (attrValue(tag, "class") ?? "").split(/\s+/);
    return classes.includes(selector.slice(1));
  }
  if (selector.startsWith("#")) return attrValue(tag, "id") === selector.slice(1);
  return tagName.toLowerCase() === selector.toLowerCase();
}

/** Merges declarations under an element's own inline style, which wins. */
function mergeStyle(tag: string, declarations: string[]): string {
  const own = attrValue(tag, "style");
  const merged = [...declarations, ...(own ? [own] : [])]
    .map((d) => d.trim().replace(/;$/, ""))
    .filter(Boolean)
    .join("; ");
  if (!merged) return tag;
  const withoutStyle = own ? tag.replace(/\s+style\s*=\s*["'][^"']*["']/i, "") : tag;
  const selfClosing = /\/>$/.test(withoutStyle);
  const head = withoutStyle.slice(0, selfClosing ? -2 : -1).trimEnd();
  return `${head} style="${merged}"${selfClosing ? "/>" : ">"}`;
}

export interface InlineResult {
  svg: string;
  /** True when a `<style>` block was found but could not be fully folded in. */
  unsupported: boolean;
}

export function inlineSvgStyles(svg: string): InlineResult {
  const styleBlocks = [...svg.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)];
  if (styleBlocks.length === 0) return { svg, unsupported: false };

  const rules: Rule[] = [];
  let unsupported = false;
  for (const block of styleBlocks) {
    const parsed = parseRules(block[1]!.replace(/<!\[CDATA\[|\]\]>/g, ""));
    rules.push(...parsed.rules);
    unsupported ||= parsed.unsupported;
  }

  // Drop the stylesheet itself, then fold its rules onto every element.
  let out = svg.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");

  out = out.replace(/<([A-Za-z][\w:-]*)\b[^>]*?\/?>/g, (tag, tagName: string) => {
    if (tag.startsWith("</") || tag.startsWith("<?") || tag.startsWith("<!")) return tag;
    const declarations = rules
      .filter((r) => r.selectors.some((s) => matches(tag, tagName, s)))
      .map((r) => r.declarations);
    return declarations.length > 0 ? mergeStyle(tag, declarations) : tag;
  });

  return { svg: out.replace(/\n\s*\n\s*\n/g, "\n\n"), unsupported };
}
