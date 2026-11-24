#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { buildApp } from "./app.js";
import { runChecks } from "./checks/runner.js";
import { readAudit, verifyAudit } from "./core/audit.js";
import { detectHardware } from "./core/detect.js";
import { ensureDir, readJson, readText, toToml, writeFileAtomic } from "./core/fsutil.js";
import { findModel, findProject, loadConfig, loadDocPacks, loadLanguages, loadModels, loadPlatforms } from "./core/load.js";
import { repoRoot, ws } from "./core/paths.js";
import { HardwareInfo, type SandboxConfig } from "./core/schemas.js";
import { ensureApiToken } from "./core/secrets.js";
import { makePlan, TIERS, type Tier } from "./core/tiers.js";
import { buildIndex } from "./index/build.js";
import { embeddingModel } from "./index/estimate.js";
import { addLocalDocs, docStatus, fetchDocPack } from "./index/docs.js";
import { exportEmbeddings, importEmbeddings } from "./index/embed-cache.js";
import { LlmClient } from "./llm/client.js";
import { mineProject, saveTasks, loadTasks } from "./miner/mine.js";
import { addProject } from "./projects.js";
import { makeSandbox } from "./sandbox/sandbox.js";
import { newLoginCode } from "./setup.js";
import { serveStdio } from "./mcp.js";
import { llamaSwapConfig, modelFile } from "./swapconfig.js";
import { stringify as toYaml } from "yaml";

const VERSION = "0.0.1";

type Args = { _: string[]; [k: string]: string | boolean | string[] };

function parseArgs(argv: string[]): Args {
  const a: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (x.startsWith("--")) {
      const [k, v] = x.slice(2).split("=", 2) as [string, string | undefined];
      if (v !== undefined) a[k] = v;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) a[k] = argv[++i]!;
      else a[k] = true;
    } else a._.push(x);
  }
  return a;
}

const str = (a: Args, k: string, d = ""): string => (typeof a[k] === "string" ? (a[k] as string) : d);
const out = (s: string) => process.stdout.write(`${s}\n`);

const HELP = `openhelper — a self-hosted coding assistant on your own hardware

Setup
  init --platform NAME            create workspace/ from workspace.example (NAME: desktop, mac, ...)
  detect                          detect memory, GPU and disk; writes workspace/hw.json
  plan [--tier XS|S|M|L|XL]       show the tier, models and disk this machine needs
  llama-swap-config [--server P]  write workspace/llama-swap.yaml from the registry and platform file
  models list                     list model packs and whether their files are present
  models pin ID --file PATH [--url URL]  record a downloaded model's file name, source and SHA-256
  models path ID                  print where the model file is expected
  token                           print this machine's API token (for the dashboard login)
  open                            open the dashboard, signed in with a one-time link

Projects
  add-project PATH [--name N]     register a repo as a project (detects languages, suggests doc packs)
  docs list | fetch ID | add-local ID PATH
  index PROJECT                   build the project's search index (repos + its doc packs)
  embeddings export PROJECT [--out FILE]  write the index's embeddings to a .ohemb.gz file
  embeddings import FILE          add exported embeddings to this machine's cache; then rebuild the index
  mine-evals PROJECT [--limit N]  build eval tasks from the project's git history
  check DIR [--sandbox docker]    run the language-pack checks on a directory

Editors
  harness continue|cline          write config so Continue or Cline use your local models and OpenHelper's tools
  mcp                             MCP server on stdio (search, run_checks); started by the editor

Running
  serve                           start the node service and dashboard (binds per config.toml)
  audit [--verify]                show the audit log or verify its hash chain
`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0] ?? "help";
  switch (cmd) {
    case "help":
    case "--help":
      out(HELP);
      return;

    case "init": {
      const platform = str(a, "platform");
      if (!/^[a-z0-9_-]+$/.test(platform)) throw new Error("give --platform NAME (lowercase, e.g. desktop or mac)");
      const dest = ws.root();
      if (existsSync(join(dest, "config.toml"))) {
        out(`workspace already exists at ${dest}; leaving it alone`);
      } else {
        const example = join(repoRoot(), "workspace.example");
        cpSync(example, dest, { recursive: true, filter: (src) => !src.startsWith(join(example, "platforms")) });
        // One machine to start with: both workflow aliases point at it, and only its platform file
        // is created. Add other machines later (docs/SETUP.md, "A second machine").
        const onMac = process.platform === "darwin";
        let cfg = readText(join(dest, "config.toml"))
          .replace(/^self\s*=.*$/m, `self = "${platform}"`)
          .replace(/^plan\s*=.*$/m, `plan = "${platform}"`)
          .replace(/^build\s*=.*$/m, `build = "${platform}"`);
        // Prompt processing is the slow part on Apple Silicon, so retrieve fewer passages.
        if (onMac) cfg = cfg.replace(/^retrieval_top_k\s*=.*$/m, "retrieval_top_k = 5");
        writeFileAtomic(join(dest, "config.toml"), cfg);
        const template = existsSync(join(example, "platforms", `${platform}.toml`))
          ? readText(join(example, "platforms", `${platform}.toml`))
          : readText(join(example, "platforms", onMac ? "mac.toml" : "desktop.toml")).replace(/^name = ".*"$/m, `name = "${platform}"`);
        writeFileAtomic(join(dest, "platforms", `${platform}.toml`), template.replace(/^url = ".*"$/m, 'url = "http://127.0.0.1:8740"'));
        out(`created workspace at ${dest} for platform "${platform}"`);
      }
      ensureApiToken();
      out("API token created in workspace/secrets/api-token (show it with `./openhelper token`).");
      return;
    }

    case "token":
      out(ensureApiToken());
      return;

    case "open": {
      const cfg = loadConfig();
      if (cfg.bind !== "127.0.0.1" && cfg.bind !== "localhost") {
        out(`Open http://${cfg.bind}:${cfg.port} and sign in with the token from \`./openhelper token\`.`);
        return;
      }
      const base = `http://127.0.0.1:${cfg.port}`;
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        up = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
        if (!up) await new Promise((r) => setTimeout(r, 500));
      }
      if (!up) throw new Error(`the engine is not answering on ${base}; check workspace/logs/`);
      ensureApiToken();
      // In the fragment, so the code never reaches a server log.
      const url = `${base}/#/login/${newLoginCode()}`;
      // wslview opens the Windows browser from WSL, where xdg-open is often missing.
      const openers = process.platform === "darwin" ? ["open"] : ["xdg-open", "wslview"];
      const opened = openers.some((cmd) => spawnSync(cmd, [url], { stdio: "ignore" }).status === 0);
      out(opened ? "Opened the dashboard in your browser." : `Open this link on this machine within 5 minutes:\n  ${url}`);
      return;
    }

    case "detect": {
      const hw = detectHardware(ws.root());
      ensureDir(ws.root());
      writeFileAtomic(ws.hw(), JSON.stringify(hw, null, 2));
      out(JSON.stringify(hw, null, 2));
      return;
    }

    case "plan": {
      const hw = HardwareInfo.parse(readJson(ws.hw(), null) ?? detectHardware(ws.root()));
      const tier = str(a, "tier") as Tier | "";
      if (tier && !TIERS.some((t) => t.tier === tier)) throw new Error(`tier must be one of ${TIERS.map((t) => t.tier).join(", ")}`);
      const plan = makePlan(hw, loadModels(), tier || undefined);
      const t = TIERS.find((x) => x.tier === plan.tier)!;
      out(`Machine: ${hw.cpu}, ${hw.ram_gb} GB RAM, ${hw.gpu.vendor === "none" ? "no GPU" : `${hw.gpu.name}${hw.gpu.vram_gb ? ` (${hw.gpu.vram_gb} GB)` : ""}`}`);
      out(`Usable model memory: ${plan.usable_gb} GB  →  tier ${plan.tier} (${t.notes})`);
      for (const [role, m] of [["main", plan.main], ["light", plan.light], ["reviewer", plan.reviewer], ["embed", plan.embed]] as const) {
        out(`  ${role.padEnd(9)} ${m ? `${m.id}  (${m.size_gb} GB, ${m.kind}${m.verified ? ", verified" : ""})` : "—"}`);
      }
      out(`Download: ${plan.download_gb} GB   Disk needed (with 20% margin): ${plan.disk_needed_gb} GB   Free: ${hw.free_disk_gb} GB`);
      for (const w of plan.warnings) out(`  ! ${w}`);
      if (a.json) out(JSON.stringify(plan, null, 2));
      return;
    }

    case "llama-swap-config": {
      const cfg = loadConfig();
      const p = loadPlatforms().find((x) => x.name === cfg.self);
      if (!p) throw new Error(`no platform file for ${cfg.self}`);
      const server = str(a, "server", join(repoRoot(), "vendor", "llama.cpp", "build", "bin", "llama-server"));
      const yaml = llamaSwapConfig(p, loadModels(), server);
      writeFileAtomic(join(ws.root(), "llama-swap.yaml"), yaml);
      out(`wrote ${join(ws.root(), "llama-swap.yaml")}`);
      return;
    }

    case "models": {
      const sub = a._[1] ?? "list";
      if (sub === "list") {
        for (const m of loadModels()) {
          const f = modelFile(m);
          out(`${m.id.padEnd(28)} ${String(m.size_gb).padStart(5)} GB  ${m.roles.join(",").padEnd(16)} ${existsSync(f) ? "present" : "missing"}  ${m.sha256 ? "pinned" : "unpinned"}`);
        }
        return;
      }
      if (sub === "path") {
        out(modelFile(findModel(a._[2] ?? "")));
        return;
      }
      if (sub === "pin") {
        const id = a._[2];
        const file = str(a, "file");
        if (!id || !file) throw new Error("usage: models pin ID --file PATH");
        const m = findModel(id);
        out(`hashing ${file} …`);
        const sha = await sha256File(file);
        // Recording where the file came from lets another machine download the same bytes.
        const url = str(a, "url", m.source.url);
        const override = { ...m, sha256: sha, source: { ...m.source, filename: basename(file), url } };
        writeFileAtomic(join(ws.packs(), "models", `${id}.toml`), toToml(override as unknown as Record<string, unknown>));
        out(`pinned ${id}: ${sha}\n(workspace/packs/models/${id}.toml; move the file to ${modelFile(override)} if it is elsewhere)`);
        return;
      }
      throw new Error(`unknown models subcommand ${sub}`);
    }

    case "add-project": {
      const path = a._[1];
      if (!path) throw new Error("usage: add-project PATH [--name NAME]");
      const { name, file, languages, docs } = addProject(path, str(a, "name"));
      out(`added project "${name}" (${file})\n  languages: ${languages.join(", ") || "none detected"}\n  doc packs: ${docs.join(", ") || "none"}`);
      out("Next: `./openhelper docs fetch <pack>` for each doc pack, then `./openhelper index PROJECT=" + name + "`.");
      return;
    }

    case "docs": {
      const sub = a._[1] ?? "list";
      if (sub === "list") {
        for (const p of loadDocPacks()) {
          const s = docStatus(p);
          out(`${p.id.padEnd(16)} ${s.fetched ? `${s.files} files` : "not fetched"}  ${p.local_command ? "(local)" : p.sources.length ? "" : "(manual: add on the Library page)"}  ${p.license}`);
        }
        return;
      }
      if (sub === "fetch") {
        const p = loadDocPacks().find((x) => x.id === a._[2]);
        if (!p) throw new Error(`no doc pack ${a._[2]}`);
        out(`fetched ${await fetchDocPack(p, out)} files for ${p.id}`);
        return;
      }
      if (sub === "add-local") {
        const id = a._[2];
        const path = a._[3];
        if (!id || !path) throw new Error("usage: docs add-local ID PATH");
        out(`added ${addLocalDocs(id, resolve(path))} files for ${id}`);
        return;
      }
      throw new Error(`unknown docs subcommand ${sub}`);
    }

    case "index": {
      const project = findProject(a._[1] ?? "");
      const cfg = loadConfig();
      const p = loadPlatforms().find((x) => x.name === cfg.self);
      const embed = str(a, "embed", p ? embeddingModel(project, p) : "");
      const meta = await buildIndex(project, { log: out, ...(embed ? { llm: new LlmClient(cfg.llm_url), embedModel: embed } : {}) });
      out(`indexed ${meta.chunks} chunks (${meta.dims ? `hybrid, ${meta.dims}-dim embeddings` : "keyword only"}), ${meta.redactions} secrets redacted`);
      return;
    }

    case "embeddings": {
      const sub = a._[1];
      if (sub === "export") {
        const project = findProject(a._[2] ?? "").name;
        const file = resolve(str(a, "out", `${project}-embeddings-${new Date().toISOString().slice(0, 10)}.ohemb.gz`));
        const r = exportEmbeddings(project, file);
        out(`wrote ${r.count} ${r.model} embeddings to ${file} (${(r.bytes / 1e6).toFixed(1)} MB)`);
        out("Copy it to the other machine (scp), then run `./openhelper embeddings import FILE` there and rebuild the index.");
        return;
      }
      if (sub === "import") {
        if (!a._[2]) throw new Error("usage: embeddings import FILE");
        const r = importEmbeddings(resolve(a._[2]));
        out(`added ${r.added} ${r.model} embeddings from ${r.project} (${r.already} already here)`);
        out(`Rebuild the index of a project that uses ${r.model} (\`./openhelper index PROJECT\`); it embeds only what changed since the export.`);
        return;
      }
      throw new Error("usage: embeddings export PROJECT [--out FILE] | embeddings import FILE");
    }

    case "mine-evals": {
      const project = findProject(a._[1] ?? "");
      const tasks = mineProject(project, loadLanguages(), { limit: Number(str(a, "limit", "100")) });
      const f = saveTasks(project.name, tasks);
      out(`mined ${tasks.length} candidate tasks into ${f}`);
      out("Skim them, delete any that are not good tests of the model, then press Run eval on the Projects page.");
      return;
    }

    case "evals": {
      const project = findProject(a._[1] ?? "");
      for (const t of loadTasks(project.name)) out(`${t.id}  ${t.message.split("\n")[0]}  [${t.languages.join(",")}]`);
      return;
    }

    case "check": {
      const dir = resolve(a._[1] ?? ".");
      const driver = str(a, "sandbox", "none") as SandboxConfig["driver"];
      const sandbox = makeSandbox({ driver, image: str(a, "image", "openhelper-sandbox:latest"), vm: "openhelper" });
      const r = await runChecks(dir, loadLanguages(), sandbox, { onProgress: (x) => out(`${x.status.padEnd(7)} ${x.language}/${x.id}${x.reason ? `  (${x.reason})` : ""}`) });
      out(`\nlanguages: ${r.languages.join(", ") || "none"}\nconfidence: ${r.confidence.status.toUpperCase()} — ${r.confidence.reasons.join("; ")}`);
      if (a.verbose) for (const x of r.results.filter((y) => y.status === "fail")) out(`\n--- ${x.language}/${x.id}\n${x.output}`);
      process.exitCode = r.confidence.status === "red" ? 1 : 0;
      return;
    }

    case "serve": {
      const cfg = loadConfig();
      ensureApiToken();
      if ((cfg.bind === "0.0.0.0" || cfg.bind === "::") && !a["allow-all-interfaces"]) {
        throw new Error("refusing to listen on every interface; bind to 127.0.0.1 or your Tailscale IP in config.toml");
      }
      const { app } = await buildApp({ logger: Boolean(a.verbose) });
      await app.listen({ host: cfg.bind, port: cfg.port });
      out(`OpenHelper ${cfg.self} listening on http://${cfg.bind}:${cfg.port} (roles: ${cfg.roles.join(", ")})`);
      return;
    }

    case "audit": {
      if (a.verify) {
        const i = verifyAudit();
        out(i === -1 ? "audit log intact" : `audit log broken at entry ${i}`);
        process.exitCode = i === -1 ? 0 : 1;
        return;
      }
      for (const e of readAudit(Number(str(a, "limit", "50"))).reverse()) out(`${e.ts}  ${e.actor.padEnd(12)} ${e.action}  ${e.detail ? JSON.stringify(e.detail) : ""}`);
      return;
    }

    case "mcp":
      serveStdio(VERSION);
      return;

    case "harness": {
      const which = a._[1];
      const cfg = loadConfig();
      const p = loadPlatforms().find((x) => x.name === cfg.self);
      if (!p) throw new Error(`no platform file for ${cfg.self}`);
      const apiBase = `${cfg.llm_url.replace(/\/+$/, "")}/v1`;
      const mcp = {
        command: process.execPath,
        args: [join(repoRoot(), "server", "dist", "cli.js"), "mcp"],
        env: { OPENHELPER_ROOT: repoRoot(), OPENHELPER_WORKSPACE: ws.root() },
      };
      const dir = join(ws.root(), "harness");
      if (which === "continue") {
        const models = [
          { name: `OpenHelper: ${p.model.current}`, provider: "openai", model: p.model.current, apiBase, apiKey: "local", roles: ["chat", "edit", "apply"] },
          ...(p.model.light ? [{ name: `OpenHelper light: ${p.model.light}`, provider: "openai", model: p.model.light, apiBase, apiKey: "local", roles: ["chat", "edit"] }] : []),
        ];
        const doc = {
          name: "OpenHelper",
          version: VERSION,
          schema: "v1",
          models,
          mcpServers: [{ name: "OpenHelper", ...mcp }],
          rules: [
            "Before using an API, flag, header or package you are not sure exists, call the OpenHelper search tool and cite the passage like [S1]. If you can't find it, say it is unverified.",
            "After editing code, call OpenHelper run_checks on the project directory before saying the change works, and report the status it returns.",
          ],
        };
        const f = join(dir, "continue-config.yaml");
        writeFileAtomic(f, `# Generated by \`node server/dist/cli.js harness continue\`.\n${toYaml(doc)}`);
        out(`wrote ${f}`);
        out("Use it in Continue: copy it to ~/.continue/config.yaml (back up yours first), or merge its models, mcpServers and rules into your existing file.");
        out("Continue's CLI (cn) reads the same file: cn --config " + f);
        return;
      }
      if (which === "cline") {
        const f = join(dir, "cline-mcp-settings.json");
        writeFileAtomic(f, JSON.stringify({ mcpServers: { openhelper: { ...mcp, disabled: false } } }, null, 2));
        out(`wrote ${f}`);
        out("In Cline (VS Code or the cline CLI):");
        out(`  1. API provider: OpenAI Compatible. Base URL: ${apiBase}. API key: local. Model ID: ${p.model.current}`);
        out("  2. Settings → Features: turn on Use Compact Prompt (local models have smaller context).");
        out(`  3. MCP servers → Configure: merge the "openhelper" entry from ${f}.`);
        return;
      }
      throw new Error("usage: harness continue|cline");
    }

    case "workspace-path":
      out(ws.root());
      return;

    default:
      throw new Error(`unknown command "${cmd}"; run \`node server/dist/cli.js help\``);
  }
}

function sha256File(path: string): Promise<string> {
  if (!existsSync(path) || !statSync(path).isFile()) return Promise.reject(new Error(`no file ${path}`));
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("end", () => res(h.digest("hex")))
      .on("error", rej);
  });
}

// `openhelper ... | head` closes the pipe early; that is not an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

main().catch((e: Error) => {
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(1);
});
