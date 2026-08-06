import type { Severity } from "./schema.js";

export interface IssueCounts {
  errors: number;
  warnings: number;
  suggestions: number;
}

/** What each severity costs the score, per issue. */
const PENALTY: Record<Severity, number> = { error: 5, warning: 2, suggestion: 0.5 };
/** Requirements are the point of the exercise; code quality is the rest. */
const REQUIREMENT_WEIGHT = 0.6;
const CODE_WEIGHT = 0.4;

export function countBySeverity(severities: Severity[]): IssueCounts {
  return {
    errors: severities.filter((s) => s === "error").length,
    warnings: severities.filter((s) => s === "warning").length,
    suggestions: severities.filter((s) => s === "suggestion").length,
  };
}

/**
 * 0-100, computed here rather than asked of the model: the same submission must
 * score the same twice, and a model's self-reported number does not.
 *
 * 60% requirements met, 40% code cleanliness — where cleanliness starts at 100
 * and each issue deducts by severity. With no requirements to judge (authoring
 * failed), the code half carries the whole score.
 */
export function computeQualityScore(counts: IssueCounts, requirementsMet: number, requirementsTotal: number): number {
  const penalty =
    counts.errors * PENALTY.error + counts.warnings * PENALTY.warning + counts.suggestions * PENALTY.suggestion;
  const codeScore = Math.max(0, 100 - penalty);

  if (requirementsTotal === 0) return Math.round(codeScore);

  const requirementScore = (requirementsMet / requirementsTotal) * 100;
  return Math.round(requirementScore * REQUIREMENT_WEIGHT + codeScore * CODE_WEIGHT);
}
