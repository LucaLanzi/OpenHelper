import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguagePack, Platform, Project, WorkspaceConfig } from "../core/schemas.js";
import { scrub } from "../core/scrub.js";
import { openIndex } from "../index/build.js";
import type { Chunk } from "../index/chunk.js";
import type { LlmClient } from "../llm/client.js";
import type { Sandbox } from "../sandbox/sandbox.js";

export interface AgentContext {
  config: WorkspaceConfig;
  platform: Platform;
  project: Project;
  llm: LlmClient;
  model: string;
  embedModel?: string;
  sandbox: Sandbox;
  languages: LanguagePack[];
  log: (line: string) => void;
  signal: AbortSignal;
  usage: { prompt_tokens: number; completion_tokens: number };
}

export interface Passage {
  label: string;
  chunk: Chunk;
}

/** Retrieve labelled passages ([S1], [S2] ...) for a query from the project's index. */
export async function retrieve(ctx: AgentContext, query: string, k = ctx.config.retrieval_top_k): Promise<Passage[]> {
  if (k <= 0) return [];
  const idx = openIndex(ctx.project.name);
  if (!idx) {
    ctx.log("no index for this project yet; answering without retrieved context (run `make index`)");
    return [];
  }
  let qv: number[] | undefined;
  if (idx.meta.dims && idx.meta.embed_model) {
    try {
      qv = (await ctx.llm.embed(idx.meta.embed_model, [query]))[0];
    } catch (e) {
      ctx.log(`embedding failed, using keyword search only: ${(e as Error).message}`);
    }
  }
  return idx.search(query, k, qv).map((chunk, i) => ({ label: `S${i + 1}`, chunk }));
}

/**
 * For evals: the index is built from the newest code, so it would show the model the answer.
 * Keep only repo passages whose text is in this older checkout.
 */
export async function retrieveAt(ctx: AgentContext, query: string, root: string, k = ctx.config.retrieval_top_k): Promise<Passage[]> {
  const inCheckout = (c: Chunk) => {
    try {
      return readFileSync(join(root, c.path), "utf8").includes(c.text);
    } catch {
      return false;
    }
  };
  const all = await retrieve(ctx, query, k * 4);
  return all
    .filter((p) => !p.chunk.source.startsWith("repo:") || inCheckout(p.chunk))
    .slice(0, k)
    .map((p, i) => ({ ...p, label: `S${i + 1}` }));
}

export function formatPassages(ps: Passage[], maxChars = 24_000): string {
  if (!ps.length) return "(no context passages were found)";
  let out = "";
  for (const p of ps) {
    const c = p.chunk;
    const block = `[${p.label}] ${c.source} ${c.path}:${c.start_line}-${c.end_line}\n\`\`\`\n${c.text}\n\`\`\`\n\n`;
    if (out.length + block.length > maxChars) break;
    out += block;
  }
  return out.trim();
}

/** Files a plan names under "Files to change", read from the worktree (scrubbed, size-capped). */
export function filesFromPlan(plan: string, root: string, maxFiles = 6, maxBytes = 40_000): { path: string; content: string }[] {
  // Models often write paths in bold, which would hide them from the pattern below.
  const section = (/##\s*Files to change([\s\S]*?)(\n##\s|$)/i.exec(plan)?.[1] ?? plan).replace(/\*/g, "");
  const paths = new Set<string>();
  for (const m of section.matchAll(/`([^`\s]+\.[A-Za-z0-9]+)`|(?:^|\s)([\w./-]+\/[\w.-]+\.[A-Za-z0-9]+|[\w-]+\.(?:py|cpp|cc|c|h|hpp|ts|tsx|js|mjs|sh|cmake|mk|txt|md|toml|json|yaml))(?=[\s:,)]|$)/gm)) {
    const p = (m[1] ?? m[2] ?? "").replace(/^\.\//, "");
    if (p && !p.startsWith("/") && !p.includes("..")) paths.add(p);
  }
  if (/Makefile/.test(section)) paths.add("Makefile");
  if (/CMakeLists\.txt/.test(section)) paths.add("CMakeLists.txt");
  const out: { path: string; content: string }[] = [];
  for (const p of paths) {
    const full = join(root, p);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, "utf8");
    if (text.length > maxBytes) continue;
    out.push({ path: p, content: scrub(text).text });
    if (out.length >= maxFiles) break;
  }
  return out;
}

export function formatFiles(files: { path: string; content: string }[]): string {
  return files.map((f) => `${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n");
}
