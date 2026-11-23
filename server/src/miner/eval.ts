import { join } from "node:path";
import { implement } from "../agent/agents.js";
import type { AgentContext } from "../agent/context.js";
import { classifyFailure, runChecks } from "../checks/runner.js";
import { assess, type CheckResult } from "../core/confidence.js";
import { ensureDir, writeFileAtomic } from "../core/fsutil.js";
import { checkoutFiles, createWorktree, removeWorktree, resetHard } from "../core/git.js";
import { ws } from "../core/paths.js";
import type { LanguagePack } from "../core/schemas.js";
import type { Sandbox } from "../sandbox/sandbox.js";
import type { EvalTask } from "./mine.js";

export interface TaskResult {
  task: string;
  passed: boolean;
  confidence: string;
  /** Did the confidence status agree with the hidden tests? (green and passed, or not green and failed) */
  status_correct: boolean;
  categories: string[];
  hallucinations: string[];
  tokens: number;
  duration_ms: number;
}

export interface EvalSummary {
  project: string;
  model: string;
  platform: string;
  tasks: number;
  passed: number;
  errors_per_100: number;
  hallucinations_per_100: number;
  green_precision: number | null;
  finished_at: string;
  results: TaskResult[];
}

/**
 * Validation: the commit's tests must fail on the parent (with the tests added) and pass on the
 * commit. Tasks that do not behave like that cannot grade a model and are dropped.
 */
export async function validateTask(t: EvalTask, packs: LanguagePack[], sandbox: Sandbox): Promise<{ ok: boolean; note: string }> {
  const id = `validate-${t.commit.slice(0, 10)}-${Date.now().toString(36)}`;
  const branch = `openhelper/${id}`;
  const dir = createWorktree(t.repo, t.base, branch, id);
  try {
    checkoutFiles(dir, t.commit, t.test_files);
    const before = await runChecks(dir, packs, sandbox, { kinds: ["build", "test"], languages: t.languages, readOnly: [t.repo] });
    resetHard(dir, t.commit);
    const after = await runChecks(dir, packs, sandbox, { kinds: ["build", "test"], languages: t.languages, readOnly: [t.repo] });
    const failsBefore = before.results.some((r) => r.status === "fail");
    const passesAfter = after.results.some((r) => r.kind === "test" && r.status === "pass") && !after.results.some((r) => r.status === "fail" || r.status === "error");
    if (failsBefore && passesAfter) return { ok: true, note: "fails before, passes after" };
    return { ok: false, note: !passesAfter ? "tests do not pass at the commit (toolchain or flaky?)" : "tests already pass before the change" };
  } finally {
    removeWorktree(t.repo, dir, branch);
  }
}

export async function runEval(ctx: AgentContext, tasks: EvalTask[], packs: LanguagePack[]): Promise<EvalSummary> {
  const results: TaskResult[] = [];
  for (const [i, t] of tasks.entries()) {
    if (ctx.signal.aborted) break;
    ctx.log(`task ${i + 1}/${tasks.length}: ${t.id} — ${t.message.split("\n")[0]}`);
    const t0 = Date.now();
    const tokens0 = ctx.usage.prompt_tokens + ctx.usage.completion_tokens;
    let graded: CheckResult[] = [];
    let confidence = "red";
    let editProblem = false;
    try {
      await implement(ctx, `## Goal\n${t.message}\n\n## Files to change\n${t.source_files.map((f) => `- \`${f}\``).join("\n")}`, {
        repo: t.repo,
        base: t.base,
        discardBranches: true,
        keepWorktree: async (dir, c) => {
          confidence = c.confidence.status;
          editProblem = c.edit_errors.length > 0;
          // Hidden tests: added only after the model is done.
          checkoutFiles(dir, t.commit, t.test_files);
          graded = (await runChecks(dir, packs, ctx.sandbox, { kinds: ["build", "test"], languages: t.languages, readOnly: [t.repo] })).results;
        },
      });
    } catch (e) {
      ctx.log(`task ${t.id} errored: ${(e as Error).message}`);
    }
    const verdict = assess(graded);
    const passed = graded.length > 0 && verdict.status !== "red" && graded.some((r) => r.kind === "test" && r.status === "pass");
    const cats = new Set<string>();
    if (editProblem) cats.add("edit");
    for (const r of graded) if (r.status === "fail") cats.add(r.kind);
    const hall = classifyFailure(graded, packs).matches;
    if (hall.length) cats.add("hallucination");
    results.push({
      task: t.id,
      passed,
      confidence,
      status_correct: (confidence === "green") === passed,
      categories: [...cats],
      hallucinations: hall,
      tokens: ctx.usage.prompt_tokens + ctx.usage.completion_tokens - tokens0,
      duration_ms: Date.now() - t0,
    });
    ctx.log(`task ${t.id}: ${passed ? "PASS" : "FAIL"} (status ${confidence})`);
  }
  const n = results.length || 1;
  const greens = results.filter((r) => r.confidence === "green");
  const summary: EvalSummary = {
    project: ctx.project.name,
    model: ctx.model,
    platform: ctx.platform.name,
    tasks: results.length,
    passed: results.filter((r) => r.passed).length,
    errors_per_100: Math.round((results.filter((r) => !r.passed).length / n) * 1000) / 10,
    hallucinations_per_100: Math.round((results.filter((r) => r.hallucinations.length).length / n) * 1000) / 10,
    green_precision: greens.length ? Math.round((greens.filter((r) => r.passed).length / greens.length) * 1000) / 1000 : null,
    finished_at: new Date().toISOString(),
    results,
  };
  const dir = join(ws.results(), ctx.project.name);
  ensureDir(dir);
  writeFileAtomic(join(dir, `eval-${ctx.model}-${summary.finished_at.replace(/[:.]/g, "-")}.json`), JSON.stringify(summary, null, 2));
  return summary;
}
