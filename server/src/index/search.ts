import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, writeFileAtomic } from "../core/fsutil.js";
import type { Chunk } from "./chunk.js";

/** Identifiers are split on case and underscores so `parseConfigFile` matches "config". */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9_]+/)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (lower.length > 1 && lower.length < 40) out.push(lower);
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[_\s]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length > 1 && p !== lower);
    out.push(...parts);
  }
  return out;
}

interface Bm25Data {
  k1: number;
  b: number;
  avgdl: number;
  docLen: number[];
  /** term → [docIndex, termFreq][] */
  postings: Record<string, [number, number][]>;
}

export class Bm25 {
  constructor(private d: Bm25Data) {}

  static build(texts: string[], k1 = 1.2, b = 0.75): Bm25 {
    const postings: Record<string, [number, number][]> = Object.create(null);
    const docLen: number[] = [];
    texts.forEach((t, i) => {
      const toks = tokenize(t);
      docLen.push(toks.length);
      const tf = new Map<string, number>();
      for (const tok of toks) tf.set(tok, (tf.get(tok) ?? 0) + 1);
      for (const [term, f] of tf) (postings[term] ??= []).push([i, f]);
    });
    const avgdl = docLen.reduce((a, x) => a + x, 0) / Math.max(1, docLen.length);
    return new Bm25({ k1, b, avgdl, docLen, postings });
  }

  get data(): Bm25Data {
    return this.d;
  }

  search(query: string, k = 10): { doc: number; score: number }[] {
    const { k1, b, avgdl, docLen, postings } = this.d;
    const n = docLen.length;
    const scores = new Map<number, number>();
    for (const term of new Set(tokenize(query))) {
      const plist = postings[term];
      if (!plist) continue;
      const idf = Math.log(1 + (n - plist.length + 0.5) / (plist.length + 0.5));
      for (const [doc, f] of plist) {
        const dl = docLen[doc]!;
        const s = idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / avgdl)));
        scores.set(doc, (scores.get(doc) ?? 0) + s);
      }
    }
    return [...scores.entries()]
      .map(([doc, score]) => ({ doc, score }))
      .sort((a, b2) => b2.score - a.score)
      .slice(0, k);
  }
}

export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Reciprocal rank fusion: robust way to merge keyword and embedding rankings. */
export function rrf(lists: number[][], k = 60): { doc: number; score: number }[] {
  const s = new Map<number, number>();
  for (const list of lists) list.forEach((doc, rank) => s.set(doc, (s.get(doc) ?? 0) + 1 / (k + rank + 1)));
  return [...s.entries()].map(([doc, score]) => ({ doc, score })).sort((a, b) => b.score - a.score);
}

export interface IndexMeta {
  project: string;
  built_at: string;
  chunks: number;
  sources: Record<string, number>;
  embed_model: string;
  dims: number;
  redactions: number;
  /** Embeddings computed by this build; the rest came from the cache. */
  embedded?: number;
}

/** On disk: chunks.jsonl, bm25.json, optional vectors.f32 + meta.json. */
export class SearchIndex {
  constructor(
    public meta: IndexMeta,
    public chunks: Chunk[],
    private bm25: Bm25,
    private vectors?: Float32Array,
  ) {}

  static save(dir: string, meta: IndexMeta, chunks: Chunk[], vectors?: Float32Array): void {
    ensureDir(dir);
    // Streamed: a big project's files pass V8's 512 MB string limit.
    writeFileAtomic(join(dir, "chunks.jsonl"), (function* () { for (const c of chunks) yield JSON.stringify(c) + "\n"; })());
    const { postings, ...rest } = Bm25.build(chunks.map((c) => `${c.title}\n${c.path}\n${c.text}`)).data;
    writeFileAtomic(join(dir, "bm25.json"), (function* () {
      yield JSON.stringify(rest).slice(0, -1) + ',"postings":{';
      let first = true;
      for (const term in postings) { yield `${first ? "" : ","}${JSON.stringify(term)}:${JSON.stringify(postings[term])}`; first = false; }
      yield "}}";
    })());
    if (vectors) writeFileAtomic(join(dir, "vectors.f32"), new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength));
    writeFileAtomic(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  }

  static load(dir: string): SearchIndex | undefined {
    if (!existsSync(join(dir, "meta.json"))) return undefined;
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as IndexMeta;
    const raw = readFileSync(join(dir, "chunks.jsonl"));
    const chunks: Chunk[] = [];
    for (let at = 0; at < raw.length; ) {
      const nl = raw.indexOf(10, at);
      const end = nl < 0 ? raw.length : nl;
      if (end > at) chunks.push(JSON.parse(raw.toString("utf8", at, end)) as Chunk);
      at = end + 1;
    }
    // ponytail: bm25.json is parsed as one string, so it must stay under 512 MB; stream-parse it if a workspace gets there.
    const bm25 = new Bm25(JSON.parse(readFileSync(join(dir, "bm25.json"), "utf8")) as Bm25Data);
    let vectors: Float32Array | undefined;
    const vf = join(dir, "vectors.f32");
    if (meta.dims && existsSync(vf)) {
      let buf = readFileSync(vf);
      // Indexes built before 0.0.2 stored base64 text; its length never equals the raw size.
      if (buf.byteLength !== meta.chunks * meta.dims * 4) buf = Buffer.from(buf.toString("utf8"), "base64");
      const ab = buf.byteOffset % 4 ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf.buffer;
      vectors = new Float32Array(ab, buf.byteOffset % 4 ? 0 : buf.byteOffset, buf.byteLength / 4);
    }
    return new SearchIndex(meta, chunks, bm25, vectors);
  }

  /** Hybrid search when a query vector is given; keyword-only otherwise. */
  search(query: string, k = 8, queryVector?: number[], filter?: (c: Chunk) => boolean): (Chunk & { score: number })[] {
    const pool = Math.max(k * 5, 40);
    const kw = this.bm25.search(query, pool).map((r) => r.doc);
    const lists = [kw];
    if (queryVector && this.vectors && this.meta.dims === queryVector.length) {
      const dims = this.meta.dims;
      const sims: { doc: number; s: number }[] = [];
      for (let i = 0; i < this.chunks.length; i++) {
        sims.push({ doc: i, s: cosine(this.vectors.subarray(i * dims, (i + 1) * dims), queryVector) });
      }
      lists.push(sims.sort((a, b) => b.s - a.s).slice(0, pool).map((x) => x.doc));
    }
    return rrf(lists)
      .map((r) => ({ ...this.chunks[r.doc]!, score: r.score }))
      .filter((c) => (filter ? filter(c) : true))
      .slice(0, k);
  }
}
