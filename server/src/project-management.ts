import { existsSync, lstatSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { detectLanguages } from "./checks/runner.js";
import { ensureDir, listFiles, toToml, writeFileAtomic } from "./core/fsutil.js";
import { isRepo } from "./core/git.js";
import { loadConfig, loadFile, loadDocPacks, loadLanguages, loadModels, loadPlatforms, loadProjects } from "./core/load.js";
import { ws } from "./core/paths.js";
import { Project } from "./core/schemas.js";
import { slugify } from "./core/util.js";
import { walkFiles } from "./core/walk.js";
import { expandHome, invalidateIndex } from "./index/build.js";

export function previewProject(repos: string[], exclude: string[] = []) {
  if (!Array.isArray(repos) || !repos.length || repos.length > 20 || !repos.every(r => typeof r === "string" && r.trim())) throw new Error("Enter one to twenty repository paths");
  const paths = [...new Set(repos.map(expandHome))];
  for (const p of paths) if (!isRepo(p)) throw new Error(`${p} is not a Git repository on this machine`);
  const languages = detectLanguages(paths.flatMap(p => walkFiles(p, { exclude, maxFiles: 20_000 })), loadLanguages());
  return { repos: paths, name: slugify(basename(paths[0]!), 30), languages: languages.map(l => l.id), docs: [...new Set(languages.flatMap(l => l.docs))].filter(id => loadDocPacks().some(d => d.id === id)) };
}
export function validateProject(input: unknown): Project {
  const p = Project.parse(input);
  const target = loadPlatforms().find(x => x.name === (p.platform || loadConfig().self));
  if (!target) throw new Error("Choose a registered execution platform");
  p.platform = target.name;
  p.repos = previewProject(p.repos, p.exclude).repos;
  for (const id of p.languages) if (!loadLanguages().some(l => l.id === id)) throw new Error(`Unknown language pack: ${id}`);
  for (const id of p.docs) if (!loadDocPacks().some(d => d.id === id)) throw new Error(`Unknown documentation: ${id}`);
  for (const id of p.checks ?? []) if (!loadLanguages().some(l => p.languages.includes(l.id) && l.checks.some(c => `${l.id}/${c.id}` === id))) throw new Error(`Unknown or unselected check: ${id}`);
  for (const id of [p.model, p.light_model].filter(Boolean)) {
    if (!loadModels().some(m => m.id === id && !m.roles.includes("embed"))) throw new Error(`Unknown generation model: ${id}`);
    if (target.model.allowed.length && !target.model.allowed.includes(id) && id !== target.model.current && id !== target.model.light) throw new Error(`${id} is not offered on ${target.name}`);
  }
  if (p.search === "hybrid") {
    p.embed_model ||= target.model.embed;
    if (!p.embed_model || !loadModels().some(m => m.id === p.embed_model && m.roles.includes("embed"))) throw new Error("Choose an available embedding model for hybrid search");
  }
  return p;
}
export function saveProject(p: Project) {
  if (loadProjects().some(x => x.name === p.name) || existsSync(join(ws.projects(), `${p.name}.toml`))) throw new Error(`Project ${p.name} already exists`);
  writeFileAtomic(join(ws.projects(), `${p.name}.toml`), toToml(p));
}
export function removalPaths(p: Project): string[] {
  // Find by parsed name, including legacy files whose basename differs.
  const configs = listFiles(ws.projects(), [".toml"]).filter(f => loadFile(Project,f).name === p.name);
  if (!configs.length) throw new Error("Project filename must match its name before removal");
  return [...configs, ws.index(p.name), ws.evals(p.name), join(ws.results(), p.name), join(ws.staged(), "projects", `${p.name}.toml`)].filter(existsSync);
}
export function removeProjectFiles(p: Project): string[] {
  const paths = removalPaths(p);
  const root = realpathSync(ws.root());
  const repos = p.repos.filter(r => existsSync(expandHome(r))).map(r => realpathSync(expandHome(r)));
  const inside = (a: string, b: string) => b === a || (!relative(a,b).startsWith("..") && !relative(a,b).startsWith("/"));
  for (const path of paths) {
    if (lstatSync(path).isSymbolicLink() || !inside(root, realpathSync(dirname(path)))) throw new Error("Refusing cleanup through a symbolic link outside the workspace");
    const full = realpathSync(path);
    if (repos.some(repo => inside(full,repo) || inside(repo,full))) throw new Error("Cleanup overlaps a source repository; move the project state before removing it");
  }
  // Rename first, rollback if any move fails. No recursive removal ever visits a repo path.
  const removedRoot=join(ws.root(),".removed");
  if (existsSync(removedRoot) && lstatSync(removedRoot).isSymbolicLink()) throw new Error("Refusing cleanup through a symbolic link");
  const trash = ensureDir(join(ws.root(), ".removed", `${p.name}-${Date.now()}`));
  const moved: [string,string][] = [];
  try { for (const [i,path] of paths.entries()) { const dest = join(trash,String(i)); renameSync(path,dest); moved.push([path,dest]); } }
  catch (e) { for (const [path,dest] of moved.reverse()) renameSync(dest,path); throw e; }
  invalidateIndex(p.name);
  rmSync(trash, { recursive: true, force: true });
  return paths.map(f => relative(ws.root(),f));
}
