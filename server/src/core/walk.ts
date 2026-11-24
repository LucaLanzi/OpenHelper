import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, relative } from "node:path";
import { matchesAny } from "./util.js";

export const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  "build",
  "dist",
  "out",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".cache",
  ".idea",
  ".vscode",
  "cmake-build-debug",
  "cmake-build-release",
  "build-fprime-automatic-native",
  // Generated coverage reports: copies of the source wrapped in HTML.
  "coverage",
  "htmlcov",
];

export interface WalkOptions {
  ignoreDirs?: string[];
  exclude?: string[];
  maxFileBytes?: number;
  maxFiles?: number;
}

/** Relative paths of text files under root, skipping build output and binaries. */
export function walkFiles(root: string, opts: WalkOptions = {}): string[] {
  const ignore = new Set(opts.ignoreDirs ?? DEFAULT_IGNORES);
  const maxBytes = opts.maxFileBytes ?? 512 * 1024;
  const maxFiles = opts.maxFiles ?? 50_000;
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const rel = relative(root, full).split("\\").join("/");
      if (st.isDirectory()) {
        if (!ignore.has(name) && !(opts.exclude && matchesAny(`${rel}/`, opts.exclude))) stack.push(full);
      } else if (st.isFile() && st.size <= maxBytes) {
        if (opts.exclude && matchesAny(rel, opts.exclude)) continue;
        if (!looksBinary(full)) out.push(rel);
      }
    }
  }
  return out.sort();
}

export function looksBinary(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  } finally {
    closeSync(fd);
  }
}
