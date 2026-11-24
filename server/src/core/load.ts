import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { listFiles, readStructured, readText } from "./fsutil.js";
import { packsDir, ws } from "./paths.js";
import {
  DocPack,
  LanguagePack,
  LinksFile,
  ModelPack,
  Platform,
  Project,
  WorkflowDef,
  WorkspaceConfig,
} from "./schemas.js";

export class ConfigError extends Error {
  constructor(
    public file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
  }
}

function parseWith<T extends z.ZodType>(schema: T, file: string, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError(file, msg);
  }
  return r.data;
}

export function loadFile<T extends z.ZodType>(schema: T, file: string): z.infer<T> {
  let data: unknown;
  try {
    data = readStructured(file);
  } catch (e) {
    throw new ConfigError(file, `cannot parse: ${(e as Error).message}`);
  }
  return parseWith(schema, file, data);
}

/** Engine packs first, then the workspace's own packs, which override by id. */
function loadPackDir<T extends z.ZodType>(schema: T, sub: string, exts: string[]): z.infer<T>[] {
  const byId = new Map<string, z.infer<T>>();
  for (const dir of [join(packsDir(), sub), join(ws.packs(), sub)]) {
    for (const f of listFiles(dir, exts)) {
      const item = loadFile(schema, f) as { id?: string; name?: string };
      const key = item.id ?? item.name ?? basename(f);
      byId.set(key, item as z.infer<T>);
    }
  }
  return [...byId.values()];
}

export const loadModels = (): ModelPack[] => loadPackDir(ModelPack, "models", [".toml"]);
export const loadLanguages = (): LanguagePack[] => loadPackDir(LanguagePack, "languages", [".toml"]);
export const loadDocPacks = (): DocPack[] => loadPackDir(DocPack, "docs", [".toml"]);

export function loadWorkflows(): WorkflowDef[] {
  const byName = new Map<string, WorkflowDef>();
  for (const dir of [join(packsDir(), "workflows"), ws.workflows()]) {
    for (const f of listFiles(dir, [".yaml", ".yml"])) {
      const w = loadFile(WorkflowDef, f);
      byName.set(w.name, w);
    }
  }
  return [...byName.values()];
}

/** Prompt templates: packs/templates/<name>.md, overridable in workspace/packs/templates. */
export function loadTemplate(name: string): string {
  for (const dir of [join(ws.packs(), "templates"), join(packsDir(), "templates")]) {
    const f = join(dir, `${name}.md`);
    if (existsSync(f)) return readText(f);
  }
  throw new ConfigError(`templates/${name}.md`, "template not found");
}

export function loadConfig(): WorkspaceConfig {
  const f = ws.config();
  if (!existsSync(f)) throw new ConfigError(f, "workspace not initialised; run `./openhelper install`");
  return loadFile(WorkspaceConfig, f);
}

export function loadPlatforms(): Platform[] {
  return listFiles(ws.platforms(), [".toml"]).map((f) => {
    const p = loadFile(Platform, f);
    if (basename(f, ".toml") !== p.name) throw new ConfigError(f, `file name must match name "${p.name}"`);
    if (p.auto_run && p.sandbox.driver === "none") {
      throw new ConfigError(f, "auto_run needs a sandbox driver (docker, podman or lima)");
    }
    return p;
  });
}

export function loadLinks(): LinksFile {
  const f = ws.links();
  if (!existsSync(f)) return { kill_switch: false, links: [] };
  return loadFile(LinksFile, f);
}

export function loadProjects(): Project[] {
  return listFiles(ws.projects(), [".toml"]).map((f) => loadFile(Project, f));
}

export function findProject(name: string): Project {
  const p = loadProjects().find((x) => x.name === name);
  if (!p) throw new ConfigError(ws.projects(), `no project named "${name}"`);
  return p;
}

export function findModel(id: string): ModelPack {
  const m = loadModels().find((x) => x.id === id);
  if (!m) throw new ConfigError("packs/models", `no model pack "${id}"`);
  return m;
}
