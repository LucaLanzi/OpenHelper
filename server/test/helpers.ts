import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resetAuditCache } from "../src/core/audit.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A fresh, empty workspace for one test file. */
export function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "oh-ws-"));
  process.env.OPENHELPER_WORKSPACE = dir;
  process.env.OPENHELPER_ROOT = REPO_ROOT;
  resetAuditCache();
  return dir;
}

export function write(root: string, rel: string, content: string): string {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

/** A small Python repo with history: one commit adds a function and its test. */
export function samplePythonRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "oh-repo-"));
  git(dir, "init", "-q", "-b", "main");
  write(dir, "calc/__init__.py", "");
  write(dir, "calc/ops.py", "def add(a, b):\n    return a + b\n");
  write(dir, "tests/test_ops.py", "from calc.ops import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Initial calculator with add");
  write(dir, "calc/ops.py", "def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b\n");
  write(
    dir,
    "tests/test_ops.py",
    "from calc.ops import add, mul\n\n\ndef test_add():\n    assert add(2, 3) == 5\n\n\ndef test_mul():\n    assert mul(4, 5) == 20\n",
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Add mul function for multiplying two numbers");
  write(dir, "README.md", "# calc\n\nA tiny calculator. `add` and `mul` live in calc/ops.py.\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Docs");
  return dir;
}
