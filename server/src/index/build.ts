import { setImmediate as yieldLoop } from "node:timers/promises";
import type { IndexProgress } from "./estimate.js";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadDocPacks } from "../core/load.js";
import { ws } from "../core/paths.js";
import type { Project } from "../core/schemas.js";
import { isSecretFile, scrub } from "../core/scrub.js";
import { walkFiles } from "../core/walk.js";
import type { LlmClient } from "../llm/client.js";
import { chunkFile, type Chunk } from "./chunk.js";
import { EmbedCache, embedCacheFile, embedInput } from "./embed-cache.js";
import { docFiles, docTextDir } from "./docs.js";
import { SearchIndex, type IndexMeta } from "./search.js";

const EMBED_BATCH = 32;

/** Lines on more than half of a doc pack's pages (menus, footers): noise for search, and costly to embed. */
export function boilerplate(texts: string[]): Set<string> {
  if (texts.length < 20) return new Set();
  const seen = new Map<string, number>();
  for (const t of texts) for (const l of new Set(t.split("\n"))) if (l.trim()) seen.set(l, (seen.get(l) ?? 0) + 1);
  return new Set([...seen].filter(([, k]) => k > texts.length / 2).map(([l]) => l));
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? join(process.env.HOME ?? "", p.slice(2)) : resolve(p);
}

export function repoName(p: string): string {
  return basename(expandHome(p).replace(/\/+$/, ""));
}

export interface BuildOptions {
  signal?: AbortSignal;
  progress?: (p: IndexProgress) => void;
  llm?: LlmClient;
  embedModel?: string;
  log?: (s: string) => void;
}

/** Index a project's repos and its doc packs. Secrets are scrubbed first; secret files skipped. */
export async function buildIndex(project: Project, opts: BuildOptions = {}): Promise<IndexMeta> {
  const log = opts.log ?? (() => {});
  const chunks: Chunk[] = [];
  const sources: Record<string, number> = {};
  let redactions = 0;
  const started = Date.now();
  const progress: IndexProgress = { phase: "discovering", files_discovered: 0, files_processed: 0, chunks: 0, embeddings_completed: 0, elapsed_ms: 0, eta_min_s: 0, eta_max_s: 0 };
  const report = () => { opts.signal?.throwIfAborted(); progress.elapsed_ms = Date.now()-started; progress.chunks = chunks.length; opts.progress?.({ ...progress }); };
  report();

  for (const r of project.repos) {
    const root = expandHome(r);
    if (!existsSync(root)) {
      log(`skipping missing repo ${root}`);
      continue;
    }
    const src = `repo:${repoName(r)}`;
    const files = walkFiles(root, { exclude: project.exclude });
    progress.files_discovered += files.filter(f => !isSecretFile(f)).length;
    progress.phase = "reading repositories";
    report();
    let n = 0;
    for (const rel of files) {
      if (isSecretFile(rel)) continue;
      const s = scrub(readFileSync(join(root, rel), "utf8"));
      redactions += s.redactions;
      for (const c of chunkFile(src, rel, s.text)) {
        chunks.push(c);
        n++;
      }
      progress.files_processed++;
      if (progress.files_processed % 50 === 0) { report(); await yieldLoop(); }
    }
    report();
    sources[src] = n;
    log(`${src}: ${files.length} files, ${n} chunks`);
  }

  const packs = loadDocPacks();
  for (const id of project.docs) {
    const pack = packs.find((p) => p.id === id);
    const dir = docTextDir(id);
    if (!pack || !existsSync(dir)) {
      const manual = pack && !pack.sources.length && !pack.local_command;
      log(`doc pack ${id} not fetched yet; ${manual ? "download it and add it" : "fetch it"} on the Library page`);
      continue;
    }
    const src = `doc:${id}`;
    let n = 0;
    const files = docFiles(dir).filter(f => !isSecretFile(f));
    progress.files_discovered += files.length;
    progress.phase = "reading documentation";
    const texts = files.map((rel) => scrub(readFileSync(join(dir, rel), "utf8")).text);
    const boiler = boilerplate(texts);
    for (const [i, rel] of files.entries()) {
      // Blank, not delete, so cited line numbers still match the doc file.
      const text = boiler.size ? texts[i]!.split("\n").map((l) => (boiler.has(l) ? "" : l)).join("\n") : texts[i]!;
      for (const c of chunkFile(src, rel, text)) {
        chunks.push(c);
        n++;
      }
      progress.files_processed++;
      if (progress.files_processed % 50 === 0) { report(); await yieldLoop(); }
    }
    report();
    sources[src] = n;
    log(`${src}: ${n} chunks`);
  }

  let vectors: Float32Array | undefined;
  let dims = 0;
  let embedded = 0;
  if (opts.llm && opts.embedModel) {
    progress.phase = "embedding"; report();
    log(`embedding ${chunks.length} chunks with ${opts.embedModel}`);
    const cache = new EmbedCache(embedCacheFile(opts.embedModel));
    const keys = chunks.map((c) => EmbedCache.key(embedInput(c)));
    const inputs = new Map<string, string>();
    keys.forEach((k, i) => { if (!cache.get(k)) inputs.set(k, embedInput(chunks[i]!)); });
    const missing = [...inputs.keys()];
    const done = () => { progress.embeddings_completed = chunks.length - missing.length + embedded; report(); };
    log(`${missing.length} chunks need embeddings; the other ${chunks.length - missing.length} are cached or duplicates`);
    done();
    try {
      // One request at a time: a batch already fills every llama-server slot, and more in flight measured no faster.
      for (let i = 0; i < missing.length; i += EMBED_BATCH) {
        const part = missing.slice(i, i + EMBED_BATCH);
        opts.signal?.throwIfAborted();
        cache.add(part, await opts.llm.embed(opts.embedModel, part.map((k) => inputs.get(k)!)));
        embedded += part.length; done();
      }
      dims = cache.dims;
      vectors = new Float32Array(chunks.length * dims);
      keys.forEach((k, i) => vectors!.set(cache.get(k)!, i * dims));
    } catch (e) {
      opts.signal?.throwIfAborted();
      // Keyword search still works, so a model server problem shouldn't leave the repo unsearchable.
      log(`embeddings failed (${(e as Error).message}); building a keyword-only index`);
    }
  }

  const meta: IndexMeta = {
    project: project.name,
    built_at: new Date().toISOString(),
    chunks: chunks.length,
    sources,
    embed_model: dims ? (opts.embedModel ?? "") : "",
    dims,
    redactions,
    ...(dims ? { embedded } : {}),
  };
  progress.phase = "saving"; report();
  SearchIndex.save(ws.index(project.name), meta, chunks, vectors);
  progress.phase = "complete"; report();
  return meta;
}

export function invalidateIndex(project: string) { cache.delete(project); }

const cache = new Map<string, { at: string; idx: SearchIndex }>();

/** Loads once per build; cheap re-check of meta.json picks up a rebuilt index. */
export function openIndex(project: string): SearchIndex | undefined {
  const metaFile = join(ws.index(project), "meta.json");
  if (!existsSync(metaFile)) return undefined;
  const at = (JSON.parse(readFileSync(metaFile, "utf8")) as IndexMeta).built_at;
  const hit = cache.get(project);
  if (hit && hit.at === at) return hit.idx;
  const idx = SearchIndex.load(ws.index(project));
  if (idx) cache.set(project, { at, idx });
  return idx;
}
