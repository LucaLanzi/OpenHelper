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
import { docFiles, docTextDir } from "./docs.js";
import { SearchIndex, type IndexMeta } from "./search.js";

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
    for (const rel of files) {
      for (const c of chunkFile(src, rel, scrub(readFileSync(join(dir, rel), "utf8")).text)) {
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
  if (opts.llm && opts.embedModel) {
    progress.phase = "embedding"; report();
    log(`embedding ${chunks.length} chunks with ${opts.embedModel}`);
    const batch = 32;
    const all: number[][] = [];
    try {
      for (let i = 0; i < chunks.length; i += batch) {
        const part = chunks.slice(i, i + batch).map((c) => `${c.title}\n${c.text}`.slice(0, 4000));
        opts.signal?.throwIfAborted();
        all.push(...(await opts.llm.embed(opts.embedModel, part)));
        progress.embeddings_completed = all.length; report();
      }
      dims = all[0]?.length ?? 0;
      vectors = new Float32Array(all.length * dims);
      all.forEach((v, i) => vectors!.set(v, i * dims));
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
