import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { ensureDir, writeFileAtomic } from "../core/fsutil.js";
import { ws } from "../core/paths.js";
import type { Chunk } from "./chunk.js";
import { SearchIndex } from "./search.js";

const HASH = 20; // sha1

/** What the embedding model sees for a chunk; also the cache key, so changing it re-embeds everything. */
export const embedInput = (c: Chunk) => `${c.title}\n${c.text.replace(/\n{3,}/g, "\n\n")}`.slice(0, 4000);

export function embedCacheFile(model: string): string {
  return join(ensureDir(join(ws.root(), "cache", "embeddings")), `${model.replace(/[^A-Za-z0-9._-]/g, "_")}.bin`);
}

/**
 * Embeddings keyed by sha1 of the exact model input, one append-only file per embedding model:
 * a uint32 dims header, then [20-byte hash][dims float32] records.
 * Shared by every project and rebuild, and appended after each batch, so a failed or canceled
 * build keeps its work and unchanged chunks (docs above all) are never embedded twice.
 * ponytail: stale entries are never pruned; delete the file to reset it, add compaction if it grows too big.
 */
export class EmbedCache {
  dims = 0;
  private map = new Map<string, Float32Array>();

  constructor(private file: string) {
    if (!existsSync(file)) return;
    let buf = readFileSync(file);
    if (buf.byteLength < 4) { truncateSync(file, 0); return; }
    if (buf.byteOffset % 4) buf = Buffer.from(buf);
    this.dims = buf.readUInt32LE(0);
    const rec = HASH + this.dims * 4;
    const n = Math.floor((buf.byteLength - 4) / rec);
    for (let i = 0; i < n; i++) {
      const at = 4 + i * rec;
      this.map.set(buf.toString("hex", at, at + HASH), new Float32Array(buf.buffer, buf.byteOffset + at + HASH, this.dims));
    }
    // A crash mid-append leaves a partial record; drop it so later records stay aligned.
    if (buf.byteLength !== 4 + n * rec) truncateSync(file, 4 + n * rec);
  }

  static key(input: string): string {
    return createHash("sha1").update(input).digest("hex");
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): Float32Array | undefined {
    return this.map.get(key);
  }

  add(keys: string[], vectors: ArrayLike<number>[]): void {
    if (!vectors.length) return;
    if (!this.dims) {
      this.dims = vectors[0]!.length;
      const h = Buffer.alloc(4);
      h.writeUInt32LE(this.dims);
      appendFileSync(this.file, h);
    }
    const out = Buffer.alloc(keys.length * (HASH + this.dims * 4));
    keys.forEach((k, i) => {
      const v = vectors[i]!;
      if (v.length !== this.dims) throw new Error(`embedding has ${v.length} dimensions, cache has ${this.dims}`);
      const at = i * (HASH + this.dims * 4);
      out.write(k, at, "hex");
      const f = new Float32Array(v);
      Buffer.from(f.buffer).copy(out, at + HASH);
      this.map.set(k, f);
    });
    appendFileSync(this.file, out);
  }
}

const ExportHeader = z.object({
  format: z.literal("openhelper-embeddings"),
  version: z.literal(1),
  project: z.string(),
  model: z.string().min(1),
  dims: z.number().int().min(1).max(65536),
  count: z.number().int().nonnegative(),
});

/**
 * Writes a project's index embeddings to a gzip file another machine can import into its cache:
 * one JSON header line, then cache-format [hash][dims float32] records. Keys are content hashes and
 * chunk titles use repo-relative paths, so they match on a machine where the repo lives elsewhere.
 */
export function exportEmbeddings(project: string, file: string): { model: string; count: number; bytes: number } {
  const idx = SearchIndex.load(ws.index(project));
  if (!idx) throw new Error(`${project} has no index yet; build it first`);
  const { dims, embed_model: model } = idx.meta;
  if (!dims || !model || !idx.vectors) throw new Error(`${project}'s index has no embeddings; switch it to hybrid search and rebuild it first`);
  const seen = new Set<string>();
  const parts: Buffer[] = [];
  idx.chunks.forEach((c, i) => {
    const k = EmbedCache.key(embedInput(c));
    if (seen.has(k)) return;
    seen.add(k);
    const v = idx.vectors!.subarray(i * dims, (i + 1) * dims);
    parts.push(Buffer.from(k, "hex"), Buffer.from(v.buffer, v.byteOffset, v.byteLength));
  });
  const header = JSON.stringify({ format: "openhelper-embeddings", version: 1, project, model, dims, count: seen.size } satisfies z.infer<typeof ExportHeader>);
  // ponytail: built in memory, fine to a few hundred MB; stream through createGzip if exports get bigger.
  const out = gzipSync(Buffer.concat([Buffer.from(`${header}\n`), ...parts]));
  writeFileAtomic(file, out);
  return { model, count: seen.size, bytes: out.byteLength };
}

/** Adds an exported file's embeddings to this machine's cache; the next index build uses them instead of embedding. */
export function importEmbeddings(file: string): { project: string; model: string; added: number; already: number } {
  let buf: Buffer;
  try { buf = gunzipSync(readFileSync(file)); } catch (e) { throw new Error(`${file} is not an embeddings export (${(e as Error).message})`); }
  const nl = buf.indexOf(10);
  let h: z.infer<typeof ExportHeader>;
  try { h = ExportHeader.parse(JSON.parse(buf.toString("utf8", 0, nl))); } catch { throw new Error(`${file} is not an embeddings export`); }
  const rec = HASH + h.dims * 4;
  if (nl < 0 || buf.byteLength - nl - 1 !== h.count * rec) throw new Error(`${file} is damaged or incomplete; export it again`);
  const cache = new EmbedCache(embedCacheFile(h.model));
  if (cache.dims && cache.dims !== h.dims) throw new Error(`${file} has ${h.dims}-dimension embeddings but this machine's ${h.model} cache has ${cache.dims}`);
  const keys: string[] = [];
  const vectors: Float32Array[] = [];
  for (let at = nl + 1; at < buf.byteLength; at += rec) {
    const k = buf.toString("hex", at, at + HASH);
    if (cache.get(k)) continue;
    keys.push(k);
    vectors.push(new Float32Array(buf.buffer.slice(buf.byteOffset + at + HASH, buf.byteOffset + at + rec)));
  }
  cache.add(keys, vectors);
  return { project: h.project, model: h.model, added: keys.length, already: h.count - keys.length };
}
