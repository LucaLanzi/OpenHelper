import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write atomically: temp file, then rename, so a crash never leaves half a config. */
export function writeFileAtomic(path: string, data: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function readStructured(path: string): unknown {
  const text = readText(path);
  if (path.endsWith(".toml")) return parseToml(text);
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return parseYaml(text);
  if (path.endsWith(".json")) return JSON.parse(text);
  throw new Error(`Unsupported config format: ${path}`);
}

export function toToml(value: Record<string, unknown>): string {
  return stringifyToml(value);
}

export function listFiles(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => exts.some((e) => f.endsWith(e)))
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile())
    .sort();
}

export function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isDirectory())
    .sort();
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readText(path)) as T;
}
