import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { ensureDir, writeFileAtomic } from "./fsutil.js";

/**
 * Edits are exchanged as search/replace blocks rather than whole files, so a small fix
 * costs a few tokens instead of regenerating the file:
 *
 *   path/to/file.py
 *   <<<<<<< SEARCH
 *   exact existing lines
 *   =======
 *   replacement lines
 *   >>>>>>> REPLACE
 *
 * An empty SEARCH creates a new file (it must not exist yet).
 */
export interface EditBlock {
  path: string;
  search: string;
  replace: string;
}

export interface EditOutcome {
  path: string;
  ok: boolean;
  error?: string;
}

const START = /^<{5,9} SEARCH\s*$/;
const MID = /^={5,9}\s*$/;
const END = /^>{5,9} REPLACE\s*$/;

export function parseEditBlocks(text: string): EditBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: EditBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!START.test(lines[i]!)) continue;
    // The path is the nearest non-empty line above, without fences or markdown decoration.
    let p = i - 1;
    while (p >= 0 && (lines[p]!.trim() === "" || lines[p]!.trim().startsWith("```"))) p--;
    const path = p >= 0 ? cleanPath(lines[p]!) : "";
    const search: string[] = [];
    const replace: string[] = [];
    let j = i + 1;
    while (j < lines.length && !MID.test(lines[j]!)) search.push(lines[j++]!);
    j++;
    while (j < lines.length && !END.test(lines[j]!)) replace.push(lines[j++]!);
    if (j >= lines.length) break; // unterminated block: ignore rather than guess
    blocks.push({ path, search: search.join("\n"), replace: replace.join("\n") });
    i = j;
  }
  return blocks;
}

function cleanPath(line: string): string {
  return line
    .trim()
    .replace(/^[#*`\s]+/, "")
    .replace(/^(file\s*path|file|path)\s*:\s*/i, "")
    .replace(/^[*`\s]+|[*`:\s]+$/g, "");
}

/** Refuse paths that escape the worktree or touch git internals. */
export function safeJoin(root: string, p: string): string | undefined {
  if (!p || isAbsolute(p)) return undefined;
  const full = normalize(join(root, p));
  const rel = relative(root, full);
  if (rel.startsWith("..") || rel === "" || rel.split(/[\\/]/).includes(".git")) return undefined;
  return full;
}

export function applyEditBlocks(root: string, blocks: EditBlock[]): EditOutcome[] {
  const out: EditOutcome[] = [];
  for (const b of blocks) {
    const full = safeJoin(root, b.path);
    if (!full) {
      out.push({ path: b.path, ok: false, error: "path outside the project or invalid" });
      continue;
    }
    if (b.search.trim() === "") {
      // The line above the block was a sentence, so this would create a junk file named after it.
      if (/\s/.test(b.path)) {
        out.push({ path: b.path, ok: false, error: "not a file path" });
        continue;
      }
      if (existsSync(full)) {
        out.push({ path: b.path, ok: false, error: "empty SEARCH but file already exists" });
        continue;
      }
      ensureDir(dirname(full));
      writeFileAtomic(full, ensureTrailingNewline(b.replace));
      out.push({ path: b.path, ok: true });
      continue;
    }
    if (!existsSync(full)) {
      out.push({ path: b.path, ok: false, error: "file does not exist" });
      continue;
    }
    const original = readFileSync(full, "utf8");
    const count = occurrences(original, b.search);
    if (count === 0) {
      out.push({ path: b.path, ok: false, error: "SEARCH text not found exactly" });
      continue;
    }
    if (count > 1) {
      out.push({ path: b.path, ok: false, error: `SEARCH text matches ${count} places; add context to make it unique` });
      continue;
    }
    writeFileAtomic(full, original.replace(b.search, () => b.replace));
    out.push({ path: b.path, ok: true });
  }
  return out;
}

function occurrences(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}
