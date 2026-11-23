import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { ensureDir, readJson, writeFileAtomic } from "../core/fsutil.js";
import { ws } from "../core/paths.js";
import type { DocPack } from "../core/schemas.js";
import { walkFiles } from "../core/walk.js";
import { htmlToText, nodeApiJsonToMarkdown } from "./chunk.js";

/**
 * Doc packs are fetched by each user and never bundled. A source without a pinned SHA-256 is
 * recorded on first download (trust on first use) in workspace/docs/lock.json, and any later
 * download that does not match is refused.
 */

type Lock = Record<string, { url: string; sha256: string; fetched_at: string }>;

const lockFile = () => join(ws.docs(), "lock.json");

export function docTextDir(pack: string): string {
  return join(ws.docs(), pack, "text");
}

/** Doc files can be large (the Node.js API is one file), so they get a higher limit than source files. */
export function docFiles(dir: string): string[] {
  return walkFiles(dir, { maxFileBytes: 16 * 1024 * 1024 });
}

export function docStatus(pack: DocPack): { fetched: boolean; files: number; locked: boolean } {
  const dir = docTextDir(pack.id);
  const lock = readJson<Lock>(lockFile(), {});
  const files = existsSync(dir) ? docFiles(dir).length : 0;
  return { fetched: files > 0, files, locked: pack.sources.every((s) => Boolean(s.sha256 || lock[s.url])) };
}

export async function fetchDocPack(pack: DocPack, log: (s: string) => void = () => {}): Promise<number> {
  const root = join(ws.docs(), pack.id);
  const raw = join(root, "raw");
  const text = docTextDir(pack.id);
  rmSync(raw, { recursive: true, force: true });
  rmSync(text, { recursive: true, force: true });
  ensureDir(raw);
  ensureDir(text);

  if (pack.local_command) {
    log(`running local command for ${pack.id}`);
    const out = execFileSync("sh", ["-c", pack.local_command], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: 10 * 60_000 });
    writeFileSync(join(text, `${pack.id}.txt`), out);
  }

  const lock = readJson<Lock>(lockFile(), {});
  for (const [i, src] of pack.sources.entries()) {
    log(`downloading ${src.url}`);
    const res = await fetch(src.url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok) throw new Error(`${src.url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const sha = createHash("sha256").update(buf).digest("hex");
    const pinned = src.sha256 || lock[src.url]?.sha256;
    if (pinned && pinned !== sha) throw new Error(`${src.url}: SHA-256 mismatch (expected ${pinned}, got ${sha}); refusing`);
    if (!pinned) lock[src.url] = { url: src.url, sha256: sha, fetched_at: new Date().toISOString() };
    const file = join(raw, `${i}-${basename(new URL(src.url).pathname) || "index"}`);
    writeFileSync(file, buf);
    extractInto(file, src.format, src.subdir, text);
  }
  writeFileAtomic(lockFile(), JSON.stringify(lock, null, 2));
  return docFiles(text).length;
}

/** Use docs the user already downloaded (e.g. the cppreference offline book). */
export function addLocalDocs(pack: string, path: string): number {
  const text = docTextDir(pack);
  rmSync(text, { recursive: true, force: true });
  ensureDir(text);
  const st = statSync(path);
  if (st.isDirectory()) convertTree(path, text);
  else if (/\.(tar|tgz|tar\.(gz|xz|bz2))$/.test(path)) extractInto(path, "tar", "", text);
  else if (path.endsWith(".zip")) extractInto(path, "zip", "", text);
  else convertTree(path, text);
  return docFiles(text).length;
}

function extractInto(file: string, format: string, subdir: string, textDir: string): void {
  if (format === "tar" || format === "zip") {
    const tmp = `${file}.d`;
    ensureDir(tmp);
    if (format === "tar") execFileSync("tar", ["-xf", file, "-C", tmp]);
    else execFileSync("unzip", ["-q", "-o", file, "-d", tmp]);
    let base = tmp;
    // GitHub tarballs wrap everything in one top-level folder.
    const top = walkTop(tmp);
    if (top.length === 1 && statSync(join(tmp, top[0]!)).isDirectory()) base = join(tmp, top[0]!);
    const from = subdir ? join(base, subdir) : base;
    if (!existsSync(from)) throw new Error(`subdir "${subdir}" not found in archive`);
    convertTree(from, textDir);
    rmSync(tmp, { recursive: true, force: true });
    return;
  }
  const content = readFileSync(file, "utf8");
  const name = basename(file);
  if (format === "json") writeFileSync(join(textDir, `${name}.md`), nodeApiJsonToMarkdown(JSON.parse(content)));
  else if (format === "html") writeFileSync(join(textDir, `${name}.md`), htmlToText(content));
  else writeFileSync(join(textDir, name), content);
}

function walkTop(dir: string): string[] {
  return execFileSync("ls", ["-A", dir], { encoding: "utf8" }).split("\n").filter(Boolean);
}

const TEXT_EXT = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);

function convertTree(from: string, to: string): void {
  if (statSync(from).isFile()) {
    cpSync(from, join(to, basename(from)));
    return;
  }
  for (const rel of walkFiles(from, { ignoreDirs: [".git", "node_modules"], maxFileBytes: 4 * 1024 * 1024 })) {
    const ext = extname(rel).toLowerCase();
    const src = join(from, rel);
    const dest = join(to, rel);
    if (ext === ".html" || ext === ".htm") {
      ensureDir(join(dest, ".."));
      writeFileSync(`${dest}.md`, htmlToText(readFileSync(src, "utf8")));
    } else if (TEXT_EXT.has(ext)) {
      ensureDir(join(dest, ".."));
      cpSync(src, dest);
    }
  }
}
