import { XMLValidator } from "fast-xml-parser";

/**
 * Server-side safety/validity gate for worker-produced SVG markup. Mirrors the
 * frontend sanitizer's rules (SvgBlock.jsx) so nothing we persist gets mangled
 * or blanked at render time. Returns [] when safe/valid; otherwise
 * human-readable issues that are fed straight into the LLM repair round.
 */
export function validateSvgMarkup(svg: string): string[] {
  const issues: string[] = [];
  const s = svg.trim();
  if (!/^<svg[\s>]/i.test(s)) issues.push("must start with <svg");
  if (!/viewbox\s*=/i.test(s)) issues.push("root <svg> must include a viewBox attribute");
  const wellFormed = XMLValidator.validate(s);
  if (wellFormed !== true) issues.push(`not well-formed XML: ${wellFormed.err.msg}`);
  if (/<script/i.test(s)) issues.push("script tags are forbidden");
  if (/<foreignobject/i.test(s)) issues.push("foreignObject is forbidden");
  if (/<style/i.test(s)) issues.push("style tags are forbidden");
  if (/\son[a-z]+\s*=/i.test(s)) issues.push("event handler attributes are forbidden");
  if (/javascript:/i.test(s)) issues.push("javascript: URLs are forbidden");
  if (/(?:xlink:)?href\s*=\s*["'](?!#)/i.test(s)) {
    issues.push("external href references are forbidden (only #fragment refs)");
  }
  if (/url\(\s*["']?(?!["']?#)/i.test(s)) issues.push("external url() references are forbidden");
  const ids = [...s.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) issues.push(`duplicate id "${dup}"`);
  return issues;
}
