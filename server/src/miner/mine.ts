import { join } from "node:path";
import { ensureDir, readText, writeFileAtomic } from "../core/fsutil.js";
import { git } from "../core/git.js";
import { ws } from "../core/paths.js";
import type { LanguagePack, Project } from "../core/schemas.js";
import { matchesAny } from "../core/util.js";
import { expandHome, repoName } from "../index/build.js";
import { existsSync } from "node:fs";

/**
 * An eval task is one past commit replayed for the model:
 * start at the parent, give the model only the commit message, then grade with the
 * tests that commit added or changed, plus the build.
 */
export interface EvalTask {
  id: string;
  repo: string;
  repo_name: string;
  base: string;
  commit: string;
  message: string;
  source_files: string[];
  test_files: string[];
  languages: string[];
  lines_changed: number;
  /** Filled by `--validate`: tests fail at base+tests and pass at the commit. */
  validated?: boolean;
  validation_note?: string;
}

export interface MineOptions {
  limit?: number;
  maxFiles?: number;
  maxLines?: number;
  minMessage?: number;
  maxCommits?: number;
}

const SEP = "\x1e";
const FIELD = "\x1f";

export function mineRepo(repoPath: string, packs: LanguagePack[], o: MineOptions = {}): EvalTask[] {
  const repo = expandHome(repoPath);
  const maxFiles = o.maxFiles ?? 8;
  const maxLines = o.maxLines ?? 400;
  const minMessage = o.minMessage ?? 12;
  const raw = git(repo, [
    "log",
    "--no-merges",
    `--max-count=${o.maxCommits ?? 3000}`,
    `--format=${SEP}%H${FIELD}%P${FIELD}%s%n%b${FIELD}`,
    "--numstat",
  ]);
  const tasks: EvalTask[] = [];
  for (const rec of raw.split(SEP)) {
    if (!rec.trim()) continue;
    const [sha, parents, message, stat] = rec.split(FIELD);
    if (!sha || !parents || parents.includes(" ")) continue; // root or merge commits
    const files: { path: string; lines: number }[] = [];
    for (const line of (stat ?? "").trim().split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
      if (!m) continue;
      const lines = m[1] === "-" ? 10_000 : Number(m[1]) + Number(m[2]);
      files.push({ path: m[3]!, lines });
    }
    if (!files.length || files.length > maxFiles) continue;
    const linesChanged = files.reduce((s, f) => s + f.lines, 0);
    if (linesChanged > maxLines) continue;
    const msg = (message ?? "").trim();
    if (msg.length < minMessage || /^(merge|revert|wip|bump|release|format|lint)\b/i.test(msg)) continue;

    const testGlobs = packs.flatMap((p) => p.test_globs);
    const tests = files.filter((f) => matchesAny(f.path, testGlobs)).map((f) => f.path);
    const sources = files
      .filter((f) => !tests.includes(f.path))
      .filter((f) => packs.some((p) => matchesAny(f.path, p.source_globs)))
      .map((f) => f.path);
    if (!tests.length || !sources.length) continue;
    const langs = packs.filter((p) => [...sources, ...tests].some((f) => matchesAny(f, p.source_globs))).map((p) => p.id);
    tasks.push({
      id: `${repoName(repoPath)}-${sha.slice(0, 10)}`,
      repo,
      repo_name: repoName(repoPath),
      base: parents.trim(),
      commit: sha,
      message: msg,
      source_files: sources,
      test_files: tests,
      languages: langs,
      lines_changed: linesChanged,
    });
    if (o.limit && tasks.length >= o.limit) break;
  }
  return tasks;
}

export function mineProject(project: Project, packs: LanguagePack[], o: MineOptions = {}): EvalTask[] {
  const all: EvalTask[] = [];
  for (const r of project.repos) {
    if (!existsSync(expandHome(r))) continue;
    all.push(...mineRepo(r, packs, { ...o, limit: o.limit ? o.limit - all.length : undefined }));
    if (o.limit && all.length >= o.limit) break;
  }
  return all;
}

export function tasksFile(project: string): string {
  return join(ws.evals(project), "tasks.jsonl");
}

export function saveTasks(project: string, tasks: EvalTask[]): string {
  ensureDir(ws.evals(project));
  const f = tasksFile(project);
  writeFileAtomic(f, tasks.map((t) => JSON.stringify(t)).join("\n") + (tasks.length ? "\n" : ""));
  return f;
}

export function loadTasks(project: string): EvalTask[] {
  const f = tasksFile(project);
  if (!existsSync(f)) return [];
  return readText(f)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EvalTask);
}
