import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The engine repo root is the directory that holds `packs/`.
 * Override with OPENHELPER_ROOT (tests and unusual installs).
 */
export function repoRoot(): string {
  const env = process.env.OPENHELPER_ROOT;
  if (env) return resolve(env);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "packs")) && existsSync(join(dir, "server"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

/**
 * The workspace holds one user's private data and is never committed.
 * Override with OPENHELPER_WORKSPACE.
 */
export function workspaceDir(): string {
  const env = process.env.OPENHELPER_WORKSPACE;
  if (env) return resolve(env);
  return join(repoRoot(), "workspace");
}

export const ws = {
  root: () => workspaceDir(),
  config: () => join(workspaceDir(), "config.toml"),
  hw: () => join(workspaceDir(), "hw.json"),
  platforms: () => join(workspaceDir(), "platforms"),
  links: () => join(workspaceDir(), "links.toml"),
  projects: () => join(workspaceDir(), "projects"),
  workflows: () => join(workspaceDir(), "workflows"),
  packs: () => join(workspaceDir(), "packs"),
  secrets: () => join(workspaceDir(), "secrets"),
  jobs: () => join(workspaceDir(), "jobs"),
  plans: () => join(workspaceDir(), "plans"),
  audit: () => join(workspaceDir(), "audit"),
  index: (project: string) => join(workspaceDir(), "index", project),
  evals: (project: string) => join(workspaceDir(), "evals", project),
  docs: () => join(workspaceDir(), "docs"),
  worktrees: () => join(workspaceDir(), "worktrees"),
  history: () => join(workspaceDir(), ".history"),
  staged: () => join(workspaceDir(), ".staged"),
  results: () => join(workspaceDir(), "results"),
};

export function packsDir(): string {
  return join(repoRoot(), "packs");
}
