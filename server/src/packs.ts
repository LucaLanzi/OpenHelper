import { existsSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { detectLanguages } from "./checks/runner.js";
import { toToml, writeFileAtomic } from "./core/fsutil.js";
import { loadDocPacks, loadLanguages, loadModels, loadProjects } from "./core/load.js";
import { ws } from "./core/paths.js";
import { DocPack, LanguagePack, ModelPack, type ModelRole, type Project } from "./core/schemas.js";
import { slugify } from "./core/util.js";
import { walkFiles } from "./core/walk.js";
import { expandHome } from "./index/build.js";

/** A model pack from a GGUF link. The download pins its SHA-256. */
export function addModelPack(o: { url: string; name?: string; size_gb: number; role: ModelRole; license?: string }): ModelPack {
  let url: URL;
  try {
    url = new URL(o.url);
  } catch {
    throw new Error("that is not a valid link");
  }
  if (url.protocol !== "https:") throw new Error("the link must start with https://");
  const filename = decodeURIComponent(basename(url.pathname));
  if (!filename.toLowerCase().endsWith(".gguf")) throw new Error("the link must point at a .gguf file");
  if (!(o.size_gb > 0)) throw new Error("enter the file's size in GB");
  const stem = filename.replace(/\.gguf$/i, "");
  const id = slugify(stem, 60);
  if (loadModels().some((m) => m.id === id)) throw new Error(`model ${id} already exists`);
  const pack = ModelPack.parse({
    id,
    name: o.name?.trim() || stem,
    family: id,
    kind: "dense",
    params_b: o.size_gb,
    active_params_b: o.size_gb,
    quant: /(?:^|[-_.])(I?Q\d+(?:_[A-Z0-9]+)*)/i.exec(stem)?.[1]?.toUpperCase() ?? "unknown",
    size_gb: o.size_gb,
    roles: [o.role],
    license: o.license?.trim() || "check the model card",
    min_usable_gb: Math.ceil(o.size_gb + 3),
    server_args: o.role === "embed" ? ["--embedding", "--pooling", "last"] : ["--jinja"],
    source: { filename, url: url.href },
  });
  writeFileAtomic(join(ws.packs(), "models", `${id}.toml`), toToml(pack as unknown as Record<string, unknown>));
  return pack;
}

/** A language pack from a name, its file extensions and the command that runs its tests. */
export function addLanguagePack(o: { name: string; extensions: string; test?: string }): LanguagePack {
  const name = o.name.trim();
  if (!name) throw new Error("enter a language name");
  const id = slugify(name, 30);
  if (loadLanguages().some((l) => l.id === id) || existsSync(join(ws.packs(), "languages", `${id}.toml`))) throw new Error(`language ${id} already exists`);
  const exts = o.extensions.split(/[\s,]+/).map((e) => e.replace(/^\*?\./, "").trim()).filter(Boolean);
  if (!exts.length || exts.some((e) => !/^[A-Za-z0-9_+-]+$/.test(e))) throw new Error("enter file extensions like: rs, toml");
  const globs = exts.map((e) => `**/*.${e}`);
  const test = o.test?.trim();
  const pack = LanguagePack.parse({
    id,
    name,
    detect: globs,
    source_globs: globs,
    checks: test ? [{ id: "test", name: test, kind: "test", order: 40, run: test, requires: [test.split(/\s+/)[0]], timeout_s: 1800 }] : [],
  });
  writeFileAtomic(join(ws.packs(), "languages", `${id}.toml`), toToml(pack as unknown as Record<string, unknown>));
  return pack;
}

/** Removes a language pack added on this machine. Built-in packs and packs a project uses stay. */
export function removeLanguagePack(id: string): void {
  const f = join(ws.packs(), "languages", `${id}.toml`);
  if (!existsSync(f)) throw new Error(`${id} is not a language added on this machine`);
  const users = loadProjects().filter((p) => p.languages.includes(id)).map((p) => p.name);
  if (users.length) throw new Error(`${id} is used by ${users.join(", ")}; remove it from those projects first`);
  unlinkSync(f);
}

/** A documentation pack from a name and, optionally, a download link. Without a link, add a local copy. */
export function addDocPack(o: { name: string; version?: string; license?: string; homepage?: string; url?: string; format?: string }): DocPack {
  const name = o.name.trim();
  if (!name) throw new Error("enter a documentation name");
  const id = slugify(name, 40);
  if (loadDocPacks().some((p) => p.id === id)) throw new Error(`documentation ${id} already exists`);
  const url = o.url?.trim();
  if (url && !url.startsWith("https://")) throw new Error("the link must start with https://");
  const homepage = o.homepage?.trim() ?? "";
  if (homepage && !/^https?:\/\//.test(homepage)) throw new Error("the homepage must start with https://");
  const pack = DocPack.parse({
    id,
    name,
    version: o.version?.trim() || "unversioned",
    license: o.license?.trim() || "check the source",
    homepage,
    sources: url ? [{ url, format: o.format || "tar" }] : [],
  });
  writeFileAtomic(join(ws.packs(), "docs", `${id}.toml`), toToml(pack as unknown as Record<string, unknown>));
  return pack;
}

/** A project's file with its languages and doc packs detected again, keeping the docs it already has. */
export function redetected(project: Project): string {
  const packs = loadLanguages();
  const langs = detectLanguages(project.repos.flatMap((r) => walkFiles(expandHome(r), { maxFiles: 20_000 })), packs);
  const known = new Set(loadDocPacks().map((p) => p.id));
  const docs = [...new Set([...project.docs, ...langs.flatMap((l) => l.docs).filter((d) => known.has(d))])];
  return toToml({ ...project, languages: langs.map((l) => l.id), docs });
}
