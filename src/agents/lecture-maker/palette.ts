/**
 * The diagram palette, mirrored from frontend/src/index.css.
 *
 * Two consumers need it on the server. The measurement page has to define these
 * custom properties or every `fill="var(--dia-1)"` resolves to nothing and the
 * drawing renders invisible — which would make the vision critic report an empty
 * canvas for a perfectly good diagram. And geometry.ts validates that drawings
 * stay on-palette, which needs the same key set.
 *
 * Values are duplicated from CSS because the backend cannot import it, so they
 * must be kept in step; the audit script renders a swatch fixture and compares
 * against these, which is what catches a drift.
 */

/** Custom property name → hex, exactly as declared in index.css. */
export const DIAGRAM_PALETTE: Readonly<Record<string, string>> = Object.freeze({
  "--dia-1": "#2563eb",
  "--dia-2": "#0d9488",
  "--dia-3": "#d97706",
  "--dia-4": "#9333ea",
  "--dia-5": "#dc2626",
  "--dia-1-tint": "#eff6ff",
  "--dia-2-tint": "#f0fdfa",
  "--dia-3-tint": "#fffbeb",
  "--dia-4-tint": "#faf5ff",
  "--dia-5-tint": "#fef2f2",
  "--dia-ink": "#111827",
  "--dia-ink-soft": "#6b7280",
  "--dia-surface": "#ffffff",
  "--dia-line": "#cbd5e1",
});

/** The only colour references a lecture drawing may use. */
export const ALLOWED_COLOR_VARS: ReadonlySet<string> = new Set(Object.keys(DIAGRAM_PALETTE));

/** The palette as CSS declarations, for the measurement page's :root block. */
export function paletteCss(): string {
  return Object.entries(DIAGRAM_PALETTE)
    .map(([name, hex]) => `  ${name}: ${hex};`)
    .join("\n");
}
