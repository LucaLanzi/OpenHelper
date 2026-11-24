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

  for (const r of project.repos) {
    const root = expandHome(r);
    if (!existsSync(root)) {
      log(`skipping missing repo ${root}`);
      continue;
    }
    const src = `repo:${repoName(r)}`;
    const files = walkFiles(root, { exclude: project.exclude });
    let n = 0;
    for (const rel of files) {
      if (isSecretFile(rel)) continue;
      const s = scrub(readFileSync(join(root, rel), "utf8"));
      redactions += s.redactions;
      for (const c of chunkFile(src, rel, s.text)) {
        chunks.push(c);
        n++;
      }
    }
    sources[src] = n;
    log(`${src}: ${files.length} files, ${n} chunks`);
  }

  const packs = loadDocPacks();
  for (const id of project.docs) {
    const pack = packs.find((p) => p.id === id);
    const dir = docTextDir(id);
    if (!pack || !existsSync(dir)) {
      const manual = pack && !pack.sources.length && !pack.local_command;
      log(`doc pack ${id} not fetched yet; run \`${manual ? `make docs-add ID=${id} FILE=path` : `make docs-fetch ID=${id}`}\``);
      continue;
    }
    const src = `doc:${id}`;
    let n = 0;
    for (const rel of docFiles(dir)) {
      for (const c of chunkFile(src, rel, readFileSync(join(dir, rel), "utf8"))) {
        chunks.push(c);
        n++;
      }
    }
    sources[src] = n;
    log(`${src}: ${n} chunks`);
  }

  let vectors: Float32Array | undefined;
  let dims = 0;
  if (opts.llm && opts.embedModel) {
    log(`embedding ${chunks.length} chunks with ${opts.embedModel}`);
    const batch = 32;
    const all: number[][] = [];
    for (let i = 0; i < chunks.length; i += batch) {
      const part = chunks.slice(i, i + batch).map((c) => `${c.title}\n${c.text}`.slice(0, 4000));
      all.push(...(await opts.llm.embed(opts.embedModel, part)));
    }
    dims = all[0]?.length ?? 0;
    vectors = new Float32Array(all.length * dims);
    all.forEach((v, i) => vectors!.set(v, i * dims));
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
  SearchIndex.save(ws.index(project.name), meta, chunks, vectors);
  return meta;
}

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
