import { execFileSync } from "node:child_process";
import { existsSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./fsutil.js";
import { ws } from "./paths.js";

const ENV = {
  GIT_AUTHOR_NAME: "OpenHelper",
  GIT_AUTHOR_EMAIL: "openhelper@localhost",
  GIT_COMMITTER_NAME: "OpenHelper",
  GIT_COMMITTER_EMAIL: "openhelper@localhost",
  GIT_TERMINAL_PROMPT: "0",
};

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...ENV },
    maxBuffer: 256 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function isRepo(dir: string): boolean {
  try {
    return git(dir, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

export function headSha(dir: string): string {
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

/**
 * Agents work in a separate worktree on a new branch, never in your checkout.
 * Dependency folders (node_modules, .venv) are linked in read-only so checks can run offline.
 */
export function createWorktree(repo: string, base: string, branch: string, id: string): string {
  const dir = join(ws.worktrees(), id);
  ensureDir(ws.worktrees());
  git(repo, ["worktree", "add", "-q", "-b", branch, dir, base]);
  for (const dep of ["node_modules", ".venv"]) {
    const src = join(repo, dep);
    if (existsSync(src) && !existsSync(join(dir, dep))) symlinkSync(src, join(dir, dep));
  }
  return dir;
}

export function removeWorktree(repo: string, dir: string, deleteBranch?: string): void {
  try {
    git(repo, ["worktree", "remove", "--force", dir]);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    try {
      git(repo, ["worktree", "prune"]);
    } catch {
      // ignore
    }
  }
  if (deleteBranch) {
    try {
      git(repo, ["branch", "-D", deleteBranch]);
    } catch {
      // ignore
    }
  }
}

/**
 * Diff and commit only the files the agent edited. Builds and tests leave artefacts
 * (build/, __pycache__/) in the worktree; those must never end up in your branch.
 */
export function diffPaths(dir: string, base: string, paths: string[]): string {
  if (!paths.length) return "";
  git(dir, ["add", "-A", "--", ...paths]);
  return git(dir, ["diff", "--cached", base, "--", ...paths]);
}

export function commitPaths(dir: string, paths: string[], message: string): string {
  git(dir, ["add", "-A", "--", ...paths]);
  git(dir, ["commit", "-q", "-m", message, "--", ...paths]);
  return headSha(dir);
}

export function checkoutFiles(dir: string, commit: string, files: string[]): void {
  if (files.length) git(dir, ["checkout", commit, "--", ...files]);
}

export function resetHard(dir: string, ref: string): void {
  git(dir, ["reset", "-q", "--hard", ref]);
  git(dir, ["clean", "-qfd", "-e", "node_modules", "-e", ".venv"]);
}

export function readAt(repo: string, commit: string, path: string): string | undefined {
  try {
    return git(repo, ["show", `${commit}:${path}`]);
  } catch {
    return undefined;
  }
}
