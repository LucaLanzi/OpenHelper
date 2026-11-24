import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { detectLanguages } from "./checks/runner.js";
import { toToml, writeFileAtomic } from "./core/fsutil.js";
import { isRepo } from "./core/git.js";
import { loadDocPacks, loadLanguages } from "./core/load.js";
import { ws } from "./core/paths.js";
import { slugify } from "./core/util.js";
import { walkFiles } from "./core/walk.js";
import { expandHome } from "./index/build.js";

/** Register a repo as a project: detects its languages and the doc packs they use. */
export function addProject(path: string, name?: string): { name: string; file: string; languages: string[]; docs: string[] } {
  const full = expandHome(path);
  if (!isRepo(full)) throw new Error(`${full} is not a git repository`);
  const id = name || slugify(basename(full), 30);
  if (!/^[a-z0-9_-]+$/.test(id)) throw new Error(`"${id}" is not a valid project name (lowercase letters, digits, - and _)`);
  const langs = detectLanguages(walkFiles(full, { maxFiles: 20_000 }), loadLanguages());
  const docs = [...new Set(langs.flatMap((l) => l.docs))].filter((d) => loadDocPacks().some((p) => p.id === d));
  const file = join(ws.projects(), `${id}.toml`);
  if (existsSync(file)) throw new Error(`project ${id} already exists`);
  const languages = langs.map((l) => l.id);
  writeFileAtomic(file, toToml({ name: id, repos: [full], languages, docs, exclude: [] }));
  return { name: id, file, languages, docs };
}

/** The native macOS chooser. Returns null if the person cancels. */
export function pickPath(kind: "file" | "folder"): Promise<string | null> {
  const script = `POSIX path of (choose ${kind} with prompt "Choose a ${kind} for OpenHelper")`;
  return new Promise((done, fail) => {
    execFile("osascript", ["-e", "tell current application to activate", "-e", script], { timeout: 5 * 60_000 }, (err, stdout, stderr) => {
      if (!err) return done(stdout.trim().replace(/(.)\/$/, "$1"));
      // -128 is AppleScript's "user canceled".
      if (stderr.includes("-128")) return done(null);
      fail(new Error(stderr.trim() || err.message));
    });
  });
}
