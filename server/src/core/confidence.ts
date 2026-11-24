import type { CheckKind } from "./schemas.js";

export type CheckStatus = "pass" | "fail" | "skipped" | "error";

export interface CheckResult {
  id: string;
  name: string;
  language: string;
  kind: CheckKind;
  required: boolean;
  status: CheckStatus;
  /** Last part of combined output, for the dashboard and the repair loop. */
  output: string;
  duration_ms: number;
  reason?: string;
}

export type Confidence = "green" | "amber" | "red";

export interface ConfidenceReport {
  status: Confidence;
  reasons: string[];
}

/**
 * green: every required check ran and passed, at least one test ran, and (for answers) sources were cited.
 * amber: nothing failed, but a required check was skipped, no tests exist, or citations are missing.
 * red:   a check failed or errored, or an edit could not be applied.
 * The model's own stated confidence is never an input.
 */
export function assess(results: CheckResult[], opts: { needsCitations?: boolean; citations?: number; editErrors?: number } = {}): ConfidenceReport {
  const reasons: string[] = [];
  if ((opts.editErrors ?? 0) > 0) reasons.push(`${opts.editErrors} edit(s) could not be applied`);
  const failed = results.filter((r) => r.status === "fail" || r.status === "error");
  for (const f of failed) reasons.push(`${f.language}/${f.id} ${f.status}`);
  if (reasons.length) return { status: "red", reasons };

  const skipped = results.filter((r) => r.required && r.status === "skipped");
  for (const s of skipped) reasons.push(`${s.language}/${s.id} skipped${s.reason ? `: ${s.reason}` : ""}`);
  const testsRan = results.some((r) => r.kind === "test" && r.status === "pass");
  if (results.length && !testsRan) reasons.push("no tests ran");
  if (opts.needsCitations && !(opts.citations && opts.citations > 0)) reasons.push("no sources cited");
  if (!results.length && !opts.needsCitations) reasons.push("no checks apply");
  if (reasons.length) return { status: "amber", reasons };
  return { status: "green", reasons: ["all checks passed"] };
}

/** Citation markers like [S1] that refer to retrieved passages actually supplied. */
export function countValidCitations(answer: string, supplied: number): { valid: number; invalid: number } {
  let valid = 0;
  let invalid = 0;
  for (const m of answer.matchAll(/\[S(\d+)\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= supplied) valid++;
    else invalid++;
  }
  return { valid, invalid };
}
