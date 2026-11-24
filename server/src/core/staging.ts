import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { ensureDir, listDirs, readStructured, writeFileAtomic } from "./fsutil.js";
import { ws } from "./paths.js";

/**
 * Workspace config changes go through stage → diff → apply. Apply keeps a backup and
 * rolls back automatically if the caller's health check fails.
 */

const EDITABLE = /^(config\.toml|links\.toml|(platforms|projects)\/[a-z0-9_-]+\.toml|workflows\/[a-z0-9_-]+\.ya?ml)$/;

export function assertEditable(rel: string): string {
  const norm = rel.replace(/\\/g, "/");
  if (!EDITABLE.test(norm)) throw new Error(`"${rel}" is not an editable workspace config file`);
  const full = resolve(ws.root(), norm);
  if (relative(ws.root(), full).startsWith("..")) throw new Error("path escapes the workspace");
  return full;
}

export function readConfigFile(rel: string): string {
  const full = assertEditable(rel);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

export interface StagedChange {
  file: string;
  diff: string;
  valid: boolean;
  error?: string;
}

export function stage(rel: string, content: string, validate: (file: string) => void): StagedChange {
  const live = assertEditable(rel);
  const staged = join(ws.staged(), rel);
  writeFileAtomic(staged, content);
  let error: string | undefined;
  try {
    readStructured(staged);
    validate(staged);
  } catch (e) {
    error = (e as Error).message;
  }
  const before = existsSync(live) ? readFileSync(live, "utf8") : "";
  const diff = createTwoFilesPatch(`a/${rel}`, `b/${rel}`, before, content, "", "", { context: 3 });
  return { file: rel, diff, valid: !error, ...(error ? { error } : {}) };
}

export interface ApplyResult {
  applied: boolean;
  rolled_back: boolean;
  backup: string;
  error?: string;
}

export async function apply(rel: string, health: () => Promise<boolean>): Promise<ApplyResult> {
  const live = assertEditable(rel);
  const staged = join(ws.staged(), rel);
  if (!existsSync(staged)) throw new Error(`nothing staged for ${rel}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(ws.history(), stamp, rel);
  ensureDir(dirname(backup));
  const existed = existsSync(live);
  if (existed) copyFileSync(live, backup);
  ensureDir(dirname(live));
  copyFileSync(staged, live);
  let ok = false;
  let error: string | undefined;
  try {
    ok = await health();
  } catch (e) {
    error = (e as Error).message;
  }
  if (!ok) {
    if (existed) copyFileSync(backup, live);
    else rmSync(live);
    return { applied: false, rolled_back: true, backup, error: error ?? "health check failed after apply" };
  }
  rmSync(staged);
  return { applied: true, rolled_back: false, backup };
}

/** Most recent backups first. */
export function history(): { stamp: string; files: string[] }[] {
  return listDirs(ws.history())
    .reverse()
    .slice(0, 50)
    .map((d) => ({ stamp: d.split(/[\\/]/).pop()!, files: listRel(d) }));
}

function listRel(dir: string): string[] {
  const out: string[] = [];
  for (const sub of ["", "platforms", "projects", "workflows"]) {
    const d = join(dir, sub);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      if (!statSync(join(d, name)).isDirectory()) out.push(sub ? `${sub}/${name}` : name);
    }
  }
  return out;
}

export function restore(stamp: string, rel: string): void {
  const live = assertEditable(rel);
  const backup = join(ws.history(), stamp, rel);
  if (!existsSync(backup)) throw new Error(`no backup of ${rel} at ${stamp}`);
  copyFileSync(backup, live);
}
