import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyFailure, runChecks } from "../checks/runner.js";
import { assess, countValidCitations, type CheckResult, type ConfidenceReport } from "../core/confidence.js";
import { applyEditBlocks, parseEditBlocks, safeJoin } from "../core/editblocks.js";
import { writeFileAtomic } from "../core/fsutil.js";
import { commitPaths, createWorktree, diffPaths, headSha, isRepo, removeWorktree } from "../core/git.js";
import { loadTemplate } from "../core/load.js";
import { ws } from "../core/paths.js";
import type { CheckKind } from "../core/schemas.js";
import { isSecretFile, scrub } from "../core/scrub.js";
import { render, slugify, tail } from "../core/util.js";
import { expandHome } from "../index/build.js";
import type { ChatMessage } from "../llm/client.js";
import { filesFromPlan, formatFiles, formatPassages, retrieve, retrieveAt, type AgentContext } from "./context.js";

const SYSTEM =
  "You are OpenHelper, a careful local coding assistant. Be correct before being complete. " +
  "Never invent APIs, flags, packages or files. Cite context passages like [S1]. Say 'unverified' when you are not sure.";

type Step = "plan" | "implement" | "repair" | "review" | "explain";

async function ask(ctx: AgentContext, step: Step, user: string, opts: { temperature?: number } = {}): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
  const r = await ctx.llm.chat({
    model: ctx.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    reasoning: ctx.config.reasoning[step],
    max_tokens: ctx.config.max_tokens,
    signal: ctx.signal,
  });
  ctx.usage.prompt_tokens += r.prompt_tokens;
  ctx.usage.completion_tokens += r.completion_tokens;
  ctx.log(`${step}: ${ctx.model}, ${r.prompt_tokens} prompt + ${r.completion_tokens} generated tokens in ${(r.duration_ms / 1000).toFixed(1)} s`);
  return r.content;
}

function sources(ps: Awaited<ReturnType<typeof retrieve>>) {
  return ps.map((p) => ({ label: p.label, source: p.chunk.source, path: p.chunk.path, start_line: p.chunk.start_line, end_line: p.chunk.end_line }));
}

// ---------------------------------------------------------------------------- explain

export interface ExplainOutput {
  answer: string;
  sources: ReturnType<typeof sources>;
  citations: { valid: number; invalid: number };
  confidence: ConfidenceReport;
}

export async function explain(ctx: AgentContext, question: string): Promise<ExplainOutput> {
  const ps = await retrieve(ctx, question);
  const prompt = render(loadTemplate("explain"), { project: ctx.project.name, task: question, context: formatPassages(ps) });
  const answer = await ask(ctx, "explain", prompt);
  const citations = countValidCitations(answer, ps.length);
  const confidence = assess([], { needsCitations: true, citations: citations.valid });
  if (citations.invalid) confidence.reasons.push(`${citations.invalid} citation(s) point at sources that were not supplied`);
  if (citations.invalid && confidence.status === "green") confidence.status = "amber";
  return { answer, sources: sources(ps), citations, confidence };
}

// ---------------------------------------------------------------------------- plan

export interface PlanOutput {
  plan: string;
  file: string;
  sources: ReturnType<typeof sources>;
  citations: { valid: number; invalid: number };
  unverified: number;
  allowed_commands: string[];
}

export async function plan(ctx: AgentContext, task: string): Promise<PlanOutput> {
  const ps = await retrieve(ctx, task, Math.max(ctx.config.retrieval_top_k, 10));
  const prompt = render(loadTemplate("plan"), { project: ctx.project.name, task, context: formatPassages(ps) });
  const text = await ask(ctx, "plan", prompt);
  const date = new Date().toISOString().slice(0, 10);
  const name = `${date}-${slugify(task)}-${Math.random().toString(36).slice(2, 6)}.md`;
  const file = join(ws.plans(), name);
  const header = `---\nproject: ${ctx.project.name}\nstatus: draft\nplatform: ${ctx.platform.name}\nmodel: ${ctx.model}\ncreated: ${new Date().toISOString()}\n---\n\n# ${task.split("\n")[0]}\n\n`;
  writeFileAtomic(file, header + text + "\n");
  return {
    plan: text,
    file: name,
    sources: sources(ps),
    citations: countValidCitations(text, ps.length),
    unverified: (text.match(/unverified/gi) ?? []).length,
    allowed_commands: allowedCommands(text),
  };
}

/** The approved plan's "Commands allowed" section becomes the command allowlist. */
export function allowedCommands(planText: string): string[] {
  const section = /##\s*Commands allowed([\s\S]*?)(\n##\s|$)/i.exec(planText)?.[1] ?? "";
  return section
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").replace(/^`|`$/g, "").trim())
    .filter((l) => l && l.toLowerCase() !== "none");
}

// ---------------------------------------------------------------------------- implement

export interface Candidate {
  n: number;
  branch: string;
  confidence: ConfidenceReport;
  checks: CheckResult[];
  edit_errors: string[];
  attempts: number;
  diff: string;
  files: string[];
  hallucination: string[];
}

export interface ImplementOutput {
  repo: string;
  base: string;
  best?: Candidate;
  candidates: Omit<Candidate, "diff">[];
}

export interface ImplementOptions {
  repo?: string;
  best_of?: number;
  kinds?: CheckKind[];
  /** For evals: start from this commit instead of HEAD. */
  base?: string;
  /** For evals: called with each finished candidate while its worktree still exists. */
  keepWorktree?: (dir: string, c: Candidate) => Promise<void>;
  /** For evals: delete every branch, including the best one. */
  discardBranches?: boolean;
}

const RANK = { green: 0, amber: 1, red: 2 } as const;

export async function implement(ctx: AgentContext, planText: string, o: ImplementOptions = {}): Promise<ImplementOutput> {
  const repo = expandHome(o.repo ?? ctx.project.repos[0]!);
  if (!isRepo(repo)) throw new Error(`${repo} is not a git repository`);
  const base = o.base ?? headSha(repo);
  const bestOf = Math.max(1, Math.min(8, o.best_of ?? 1));
  const jobTag = `${Date.now().toString(36)}`;
  const cands: (Candidate & { dir: string })[] = [];

  for (let n = 1; n <= bestOf; n++) {
    if (ctx.signal.aborted) throw new Error("canceled");
    const branch = `openhelper/${slugify(planText.split("\n").find((l) => l.trim()) ?? "change", 30)}-${jobTag}-${n}`;
    const dir = createWorktree(repo, base, branch, `${jobTag}-${n}`);
    ctx.log(`candidate ${n}/${bestOf}: worktree ${dir} on branch ${branch}`);
    try {
      const c = await oneCandidate(ctx, planText, repo, dir, base, n, bestOf, Boolean(o.base), o.kinds);
      cands.push({ ...c, branch, dir });
      if (o.keepWorktree) await o.keepWorktree(dir, { ...c, branch });
    } catch (e) {
      removeWorktree(repo, dir, branch);
      throw e;
    }
  }

  cands.sort((a, b) => RANK[a.confidence.status] - RANK[b.confidence.status] || failures(a) - failures(b) || a.diff.length - b.diff.length);
  const best = cands[0];
  for (const c of cands) {
    // Keep only the best branch; worktrees are always removed (the branch stays in your repo).
    removeWorktree(repo, c.dir, c === best && !o.discardBranches ? undefined : c.branch);
  }
  return {
    repo,
    base,
    ...(best ? { best: strip(best) } : {}),
    candidates: cands.map(({ diff: _d, dir: _x, ...rest }) => rest),
  };
}

function strip(c: Candidate & { dir: string }): Candidate {
  const { dir: _dir, ...rest } = c;
  return rest;
}

function failures(c: Candidate): number {
  return c.checks.filter((r) => r.status === "fail" || r.status === "error").length + c.edit_errors.length;
}

async function oneCandidate(ctx: AgentContext, planText: string, repo: string, dir: string, base: string, n: number, bestOf: number, atBase: boolean, kinds?: CheckKind[]) {
  const ps = atBase ? await retrieveAt(ctx, planText, dir) : await retrieve(ctx, planText);
  const files = filesFromPlan(planText, dir);
  const context = [formatFiles(files), formatPassages(ps)].filter(Boolean).join("\n\n");
  const prompt = render(loadTemplate("implement"), { project: ctx.project.name, plan: planText, context });
  const temperature = bestOf > 1 ? 0.2 + 0.25 * (n - 1) : 0.2;
  let reply = await ask(ctx, "implement", prompt, { temperature });
  const touched = new Set<string>();
  const missed = new Set<string>();
  let editErrors = applyAll(ctx, dir, reply, touched, missed, files);
  let attempts = 1;
  let check = await runChecks(dir, ctx.languages, ctx.sandbox, {
    ...(ctx.project.languages.length ? { languages: ctx.project.languages } : {}),
    ...(kinds?.length ? { kinds } : {}),
    changedFiles: [...touched],
    readOnly: [repo],
    onProgress: (r) => ctx.log(`check ${r.language}/${r.id}: ${r.status}${r.reason ? ` (${r.reason})` : ""}`),
  });
  let confidence = assess(check.results, { editErrors: editErrors.length });

  while (confidence.status === "red" && attempts <= ctx.config.repair_attempts) {
    if (ctx.signal.aborted) throw new Error("canceled");
    ctx.log(`repair attempt ${attempts}: ${confidence.reasons.join("; ")}`);
    const failed = check.results.filter((r) => r.status === "fail" || r.status === "error");
    const failText = [
      ...editErrors.map((e) => `edit error: ${e}`),
      ...failed.map((r) => `### ${r.language}/${r.id} (${r.status})\n${tail(r.output, 3000)}`),
    ].join("\n\n");
    // The repair call starts a fresh conversation, so give it the task and the plan's files too:
    // an edit with no usable path leaves touched and missed empty.
    const current = [...new Set([...touched, ...missed, ...files.map((f) => f.path)])]
      .slice(0, 8)
      .map((p) => {
        try {
          return { path: p, content: scrub(readFileSync(join(dir, p), "utf8").slice(0, 40_000)).text };
        } catch {
          return undefined;
        }
      })
      .filter((x): x is { path: string; content: string } => Boolean(x));
    reply = await ask(ctx, "repair", render(loadTemplate("repair"), { plan: planText, checks: failText, files: formatFiles(current) }), { temperature: 0.1 });
    editErrors = applyAll(ctx, dir, reply, touched, missed, files);
    check = await runChecks(dir, ctx.languages, ctx.sandbox, {
      ...(ctx.project.languages.length ? { languages: ctx.project.languages } : {}),
      ...(kinds?.length ? { kinds } : {}),
      changedFiles: [...touched],
      readOnly: [repo],
      onProgress: (r) => ctx.log(`check ${r.language}/${r.id}: ${r.status}`),
    });
    confidence = assess(check.results, { editErrors: editErrors.length });
    attempts++;
  }

  const changed = [...touched].sort();
  const diff = diffPaths(dir, base, changed);
  if (changed.length && diff.trim()) {
    commitPaths(dir, changed, `OpenHelper: ${planText.split("\n").find((l) => l.trim())?.slice(0, 60) ?? "change"}\n\nConfidence: ${confidence.status}`);
  }
  if (!diff.trim() && confidence.status !== "red") {
    confidence = { status: "red", reasons: ["the model made no changes"] };
  }
  const hall = classifyFailure(check.results, ctx.languages);
  ctx.log(`candidate ${n}: ${confidence.status} (${confidence.reasons.join("; ")})`);
  return { n, confidence, checks: check.results, edit_errors: editErrors, attempts, diff, files: changed, hallucination: hall.matches };
}

function applyAll(ctx: AgentContext, dir: string, reply: string, touched: Set<string>, missed: Set<string>, planFiles: { path: string; content: string }[] = []): string[] {
  const blocks = parseEditBlocks(reply);
  if (!blocks.length) return ["the reply contained no search/replace blocks"];
  // Small models often leave out the path. Pick the plan file that holds the SEARCH text, else
  // the block before it in the same reply, else the plan's only file.
  let prev = "";
  for (const b of blocks) {
    if (!b.path) {
      const holders = b.search.trim() ? planFiles.filter((f) => f.content.includes(b.search)) : [];
      const [guess, why] =
        holders.length === 1 ? [holders[0]!.path, "the plan file that contains the SEARCH text"]
        : prev ? [prev, "same as the block before"]
        : planFiles.length === 1 ? [planFiles[0]!.path, "the only file in the plan"]
        : ["", ""];
      if (guess) ctx.log(`edit with no file path: using ${guess} (${why})`);
      b.path = guess;
    }
    prev = b.path;
  }
  const out = applyEditBlocks(dir, blocks);
  for (const o of out) {
    ctx.log(`edit ${o.path}: ${o.ok ? "applied" : `failed (${o.error})`}`);
    if (o.ok) touched.add(o.path);
    // The repair prompt shows these files, so the path comes from the model and must stay inside the worktree.
    else if (safeJoin(dir, o.path) && !isSecretFile(o.path)) missed.add(o.path);
  }
  return out.filter((o) => !o.ok).map((o) => `${o.path}: ${o.error}`);
}

// ---------------------------------------------------------------------------- review

export interface ReviewOutput {
  review: string;
  verdict: "approve" | "changes needed" | "unclear";
}

export async function review(ctx: AgentContext, planText: string, patch: string, checks: string): Promise<ReviewOutput> {
  // Nothing to review: do not ask the model, which may approve an empty change.
  if (!patch.trim()) {
    ctx.log("review: the coder made no change; not asking the model");
    return { review: "## Verdict\nchanges needed\n\nThe coder made no change, so there is nothing to approve.", verdict: "changes needed" };
  }
  const prompt = render(loadTemplate("review"), {
    project: ctx.project.name,
    plan: planText,
    patch: patch.length > 60_000 ? `${patch.slice(0, 60_000)}\n… (patch truncated)` : patch,
    checks: checks || "(no checks ran)",
  });
  const text = await ask(ctx, "review", prompt);
  const v = /##\s*Verdict\s*\n+\s*\**\s*(approve|changes needed)/i.exec(text)?.[1]?.toLowerCase();
  return { review: text, verdict: v === "approve" ? "approve" : v === "changes needed" ? "changes needed" : "unclear" };
}
