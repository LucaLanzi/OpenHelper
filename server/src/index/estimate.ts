import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeFileAtomic } from "../core/fsutil.js";
import { loadDocPacks } from "../core/load.js";
import { ws } from "../core/paths.js";
import type { Platform, Project } from "../core/schemas.js";
import { isSecretFile } from "../core/scrub.js";
import { walkFiles } from "../core/walk.js";
import { expandHome } from "./build.js";
import { docFiles, docTextDir } from "./docs.js";

export interface Workload { files: number; chunks: number; doc_files: number; missing_docs: string[] }
export interface Timing { platform: string; embed_model: string; files: number; chunks: number; duration_ms: number; at: string }
export interface Estimate { platform: string; min_s: number; max_s: number; basis: string; confidence: string; explanation: string; workload: Workload }
export interface IndexProgress { phase: string; files_discovered: number; files_processed: number; chunks: number; embeddings_completed: number; elapsed_ms: number; eta_min_s: number; eta_max_s: number }
const timingFile = () => join(ws.root(), "state", "index-timings.json");
export const timings = (): Timing[] => readJson<Timing[]>(timingFile(), []);
export function recordTiming(t: Timing) { writeFileAtomic(timingFile(), JSON.stringify([...timings(), t].slice(-200))); }
export function embeddingModel(p: Project, platform: Platform): string { return p.search === "keyword" ? "" : p.embed_model || platform.model.embed; }
export function workload(p: Project): Workload {
  let files = 0, bytes = 0, doc_files = 0;
  const add = (root: string, paths: string[], doc: boolean) => {
    for (const rel of paths) { if (isSecretFile(rel)) continue; files++; if (doc) doc_files++; bytes += statSync(join(root, rel)).size; }
  };
  for (const repo of p.repos) { const root = expandHome(repo); if (existsSync(root)) add(root, walkFiles(root, { exclude: p.exclude }), false); }
  const missing_docs: string[] = [];
  for (const id of p.docs) {
    const root = docTextDir(id);
    if (loadDocPacks().some(d => d.id === id) && existsSync(root)) add(root, docFiles(root), true);
    else missing_docs.push(id);
  }
  return { files, chunks: Math.max(files, Math.ceil(bytes / 1800)), doc_files, missing_docs };
}
/** Deliberately broad cold-start ranges. No accelerator brand implies a measured speed. */
export function estimateIndex(p: Platform, work: Workload, embed: string, history = timings()): Estimate {
  const samples = history.filter(t => t.platform === p.name && t.embed_model === embed && t.chunks > 0 && t.duration_ms > 0).slice(-12);
  const cores = Math.max(1, Number(p.measured.cores) || 2);
  const ram = Math.max(1, Number(p.measured.ram_gb) || 4);
  const bench = Number(p.measured.index_chunks_per_second);
  const embedBench = Number(p.measured.embedding_chunks_per_second);
  let seconds: number, basis: string, confidence: string;
  if (samples.length) {
    const rates = samples.map(t => t.duration_ms / 1000 / t.chunks).sort((a,b) => a-b);
    seconds = work.chunks * rates[Math.floor(rates.length / 2)]!;
    basis = `historical data (${samples.length} builds)`; confidence = samples.length >= 3 ? "medium" : "low";
  } else {
    seconds = work.chunks / (bench > 0 ? bench : Math.min(400, cores * 20) * Math.min(1, ram / 8));
    const storage = Number(p.measured.storage_mb_per_second);
    if (storage > 0) seconds += work.chunks * 1800 / (storage * 1024 * 1024);
    if (embed) seconds += work.chunks / (embedBench > 0 ? embedBench : 1);
    basis = bench > 0 && (!embed || embedBench > 0) ? "benchmark" : "initial capability estimate"; confidence = "low";
  }
  const spread = confidence === "medium" ? 0.5 : 0.8;
  return { platform: p.display_name || p.name, min_s: Math.max(1, Math.floor(seconds * (1-spread))), max_s: Math.max(5, Math.ceil(seconds * (1+spread) + 5)), basis, confidence, workload: work,
    explanation: `${work.files} files including ${work.doc_files} documentation files; about ${work.chunks} chunks. ${embed ? `Embeddings: ${embed}. Chunks embedded by an earlier build, for any project, are reused, so a rebuild is usually much faster than this.` : "Keyword search only."} CPU, memory, storage, model speed and competing work affect duration. Downloads and queue wait are excluded.${work.missing_docs.length ? ` Missing documentation: ${work.missing_docs.join(", ")}; add it in Library and rebuild.` : ""}` };
}

/**
 * ETA while a build runs. Once embedding has run a while, its measured rate replaces the prior estimate.
 * `base` is the first embedding report (cache hits already counted), so reused chunks don't inflate the rate.
 */
export function liveEta(p: IndexProgress, est: { min_s: number; max_s: number; workload: Workload }, base?: { elapsed_ms: number; done: number }): [number, number] {
  if (p.phase === "complete") return [0, 0];
  if (p.phase === "embedding" && base) {
    const done = p.embeddings_completed - base.done, secs = (p.elapsed_ms - base.elapsed_ms) / 1000;
    if (done >= 64 && secs >= 10) {
      const left = (p.chunks - p.embeddings_completed) / (done / secs);
      return [Math.floor(left * 0.8), Math.ceil(left * 1.3 + 5)];
    }
  }
  const remaining = Math.max(0, 1 - (p.phase === "embedding" ? p.embeddings_completed / Math.max(1, p.chunks) : p.files_processed / Math.max(1, est.workload.files)));
  const measured = p.elapsed_ms / 1000 * remaining / Math.max(0.05, 1 - remaining);
  return [Math.max(0, Math.floor(Math.max(est.min_s - p.elapsed_ms / 1000, measured * 0.5))), Math.ceil(Math.max(est.max_s - p.elapsed_ms / 1000, measured * 2, 1))];
}
