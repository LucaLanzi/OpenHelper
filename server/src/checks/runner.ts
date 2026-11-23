import { assess, type CheckResult, type ConfidenceReport } from "../core/confidence.js";
import type { CheckKind, LanguagePack } from "../core/schemas.js";
import { matchesAny, tail } from "../core/util.js";
import { walkFiles } from "../core/walk.js";
import { shellQuote, type Sandbox } from "../sandbox/sandbox.js";

export interface CheckRun {
  languages: string[];
  results: CheckResult[];
  confidence: ConfidenceReport;
}

export function detectLanguages(files: string[], packs: LanguagePack[]): LanguagePack[] {
  return packs.filter((p) => files.some((f) => matchesAny(f, p.detect)));
}

export interface RunChecksOptions {
  /** Restrict to these languages (project setting); default: detected. */
  languages?: string[];
  /** Restrict to these kinds (workflow step setting); default: all. */
  kinds?: CheckKind[];
  /** Restrict {files} to files changed by an edit, when the check allows it. */
  changedFiles?: string[];
  readOnly?: string[];
  onProgress?: (r: CheckResult) => void;
}

/** Exit code 77 from a check means "not applicable here" (automake convention). */
export const SKIP_EXIT = 77;

export async function runChecks(dir: string, packs: LanguagePack[], sandbox: Sandbox, o: RunChecksOptions = {}): Promise<CheckRun> {
  const files = walkFiles(dir, { ignoreDirs: [".git", "node_modules", "build", "build-asan", ".venv", "venv", "__pycache__", "dist"] });
  let langs = detectLanguages(files, packs);
  if (o.languages?.length) langs = langs.filter((l) => o.languages!.includes(l.id));

  const planned = langs
    .flatMap((l) => l.checks.map((c) => ({ lang: l, check: c })))
    .filter(({ check }) => !o.kinds?.length || o.kinds.includes(check.kind))
    .sort((a, b) => a.check.order - b.check.order);

  const needed = [...new Set(planned.flatMap((p) => p.check.requires))];
  const available = await probeBinaries(sandbox, dir, needed);

  const results: CheckResult[] = [];
  for (const { lang, check } of planned) {
    const base: Omit<CheckResult, "status" | "output" | "duration_ms"> = {
      id: check.id,
      name: check.name,
      language: lang.id,
      kind: check.kind,
      required: check.required,
    };
    const skip = (reason: string) => {
      const r: CheckResult = { ...base, status: "skipped", output: "", duration_ms: 0, reason };
      results.push(r);
      o.onProgress?.(r);
    };
    if (check.when_files.length && !files.some((f) => matchesAny(f, check.when_files))) continue; // not applicable: omit
    if (check.unless_files.length && files.some((f) => matchesAny(f, check.unless_files))) continue;
    const missing = check.requires.filter((b) => !available.has(b));
    if (missing.length) {
      skip(`missing ${missing.join(", ")}`);
      continue;
    }
    let cmd = check.run;
    if (cmd.includes("{files}")) {
      let matched = files.filter((f) => matchesAny(f, check.files));
      if (o.changedFiles?.length && check.kind !== "build" && check.kind !== "test") {
        const changed = matched.filter((f) => o.changedFiles!.includes(f));
        if (changed.length) matched = changed;
      }
      if (!matched.length) continue; // nothing of this kind in the project
      cmd = cmd.replaceAll("{files}", matched.map(shellQuote).join(" "));
    }
    const run = await sandbox.run(cmd, dir, { timeoutMs: check.timeout_s * 1000, ...(o.readOnly ? { readOnly: o.readOnly } : {}) });
    const status = run.timed_out ? "error" : run.code === 0 ? "pass" : run.code === SKIP_EXIT ? "skipped" : "fail";
    const r: CheckResult = {
      ...base,
      status,
      output: tail(run.output),
      duration_ms: run.duration_ms,
      ...(run.timed_out ? { reason: `timed out after ${check.timeout_s}s` } : {}),
      ...(status === "skipped" ? { reason: lastLine(run.output) || "not applicable" } : {}),
    };
    results.push(r);
    o.onProgress?.(r);
  }
  return { languages: langs.map((l) => l.id), results, confidence: assess(results) };
}

function lastLine(s: string): string {
  return s.trim().split("\n").pop()?.slice(0, 200) ?? "";
}

async function probeBinaries(sandbox: Sandbox, dir: string, bins: string[]): Promise<Set<string>> {
  if (!bins.length) return new Set();
  const script = bins.map((b) => `command -v ${shellQuote(b)} >/dev/null 2>&1 && echo ${shellQuote(b)}`).join("; ");
  const r = await sandbox.run(`${script}; true`, dir, { timeoutMs: 60_000 });
  return new Set(r.output.split("\n").map((s) => s.trim()).filter(Boolean));
}

/** Which failures look like the model invented something (for eval scoring). */
export function classifyFailure(results: CheckResult[], packs: LanguagePack[]): { hallucination: boolean; matches: string[] } {
  const matches: string[] = [];
  for (const r of results) {
    if (r.status !== "fail") continue;
    const pack = packs.find((p) => p.id === r.language);
    for (const pat of pack?.hallucination_patterns ?? []) {
      const m = new RegExp(pat).exec(r.output);
      if (m) matches.push(`${r.language}/${r.id}: ${m[0]}`);
    }
  }
  return { hallucination: matches.length > 0, matches };
}
