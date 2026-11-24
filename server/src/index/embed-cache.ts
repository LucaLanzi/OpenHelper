import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "../core/fsutil.js";
import { ws } from "../core/paths.js";

const HASH = 20; // sha1

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

  add(keys: string[], vectors: number[][]): void {
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
