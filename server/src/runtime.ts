import { existsSync } from "node:fs";
import { join } from "node:path";
import { explain, implement, plan, review } from "./agent/agents.js";
import type { AgentContext } from "./agent/context.js";
import { runChecks } from "./checks/runner.js";
import { audit } from "./core/audit.js";
import { readJson, writeFileAtomic } from "./core/fsutil.js";
import { createWorktree, headSha, removeWorktree } from "./core/git.js";
import { findProject, loadConfig, loadDocPacks, loadFile, loadLanguages, loadModels, loadPlatforms, loadProjects } from "./core/load.js";
import { repoRoot, ws } from "./core/paths.js";
import { Platform as PlatformSchema } from "./core/schemas.js";
import type { CheckKind, Platform, WorkspaceConfig } from "./core/schemas.js";
import { apply, readConfigFile, stage } from "./core/staging.js";
import { buildIndex, expandHome } from "./index/build.js";
import { addLocalDocs, docStatus, fetchDocPack } from "./index/docs.js";
import { JobQueue, type Job } from "./jobs/queue.js";
import { LlmClient } from "./llm/client.js";
import { runEval } from "./miner/eval.js";
import { loadTasks, mineProject, saveTasks } from "./miner/mine.js";
import { limaState, makeSandbox } from "./sandbox/sandbox.js";
import { runScript, STARTER_MODELS } from "./setup.js";
import { llamaSwapConfig, modelFile } from "./swapconfig.js";

interface State {
  current_model?: string;
}

/** Everything one machine runs: its platform config, model server client, sandbox and job queue. */
export class Runtime {
  config: WorkspaceConfig;
  platform: Platform;
  llm: LlmClient;
  queue: JobQueue;

  constructor() {
    this.config = loadConfig();
    this.platform = this.reloadPlatform();
    this.llm = new LlmClient(this.config.llm_url);
    this.queue = new JobQueue((job, log, signal) => this.handle(job, log, signal));
  }

  reloadPlatform(): Platform {
    const p = loadPlatforms().find((x) => x.name === this.config.self);
    if (!p) throw new Error(`config.toml says self = "${this.config.self}" but platforms/${this.config.self}.toml does not exist`);
    this.platform = p;
    return p;
  }

  reload(): void {
    this.config = loadConfig();
    this.reloadPlatform();
    this.llm = new LlmClient(this.config.llm_url);
  }

  private stateFile() {
    return join(ws.root(), "state", `${this.platform.name}.json`);
  }

  get currentModel(): string {
    return readJson<State>(this.stateFile(), {}).current_model ?? this.platform.model.current;
  }

  /** Models offered in the picker: allowed list (or all) that this machine's measured tier fits. */
  pickerModels() {
    const all = loadModels().filter((m) => !m.roles.every((r) => r === "embed"));
    const allowed = this.platform.model.allowed;
    return all.filter((m) => !allowed.length || allowed.includes(m.id) || m.id === this.platform.model.current);
  }

  async swapModel(model: string, actor = "user"): Promise<"now" | "after-current-job"> {
    if (!this.pickerModels().some((m) => m.id === model)) throw new Error(`model "${model}" is not offered on ${this.platform.name}`);
    return this.queue.requestSwap(model, async () => {
      writeFileAtomic(this.stateFile(), JSON.stringify({ current_model: model }, null, 2));
      await this.llm.unloadAll();
      audit(actor, "model.swap", { model }, this.platform.name);
    });
  }

  private ctx(job: Job, log: (s: string) => void, signal: AbortSignal): AgentContext {
    const project = findProject(job.project);
    return {
      config: this.config,
      platform: this.platform,
      project,
      llm: this.llm,
      model: job.model || this.currentModel,
      ...(this.platform.model.embed ? { embedModel: this.platform.model.embed } : {}),
      sandbox: makeSandbox(this.platform.sandbox),
      languages: loadLanguages(),
      log,
      signal,
      usage: job.usage,
    };
  }

  private async handle(job: Job, log: (s: string) => void, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (job.type === "docs") {
      const id = String(job.input.pack ?? "");
      const pack = loadDocPacks().find((p) => p.id === id);
      if (!pack) throw new Error(`no doc pack ${id}`);
      return { files: await fetchDocPack(pack, log) };
    }
    if (job.type === "docs-local") {
      const files = addLocalDocs(String(job.input.pack), expandHome(String(job.input.path)));
      log(`added ${files} files for ${String(job.input.pack)}; rebuild a project's index to use them`);
      return { files };
    }
    if (job.type === "setup-model") {
      for (const id of STARTER_MODELS) {
        if (this.hasModel(id)) log(`${id}: already downloaded`);
        else await runScript("download-model.sh", [id], { OH_YES: "1" }, log, signal);
      }
      await this.useStarterModels();
      log("models are ready");
      return { models: [...STARTER_MODELS] };
    }
    if (job.type === "setup-sandbox") {
      await runScript("sandbox-vm.sh", [], { YES: "1" }, log, signal);
      this.reload();
      return { driver: this.platform.sandbox.driver };
    }
    const ctx = this.ctx(job, log, signal);
    const s = (k: string) => (typeof job.input[k] === "string" ? (job.input[k] as string) : "");
    switch (job.type) {
      case "explain":
        return { ...(await explain(ctx, s("task"))) };
      case "plan":
        return { ...(await plan(ctx, s("task"))) };
      case "implement":
        return {
          ...(await implement(ctx, s("plan") || s("task"), {
            ...(s("repo") ? { repo: s("repo") } : {}),
            best_of: Number(job.input.best_of ?? 1),
            ...(Array.isArray(job.input.kinds) ? { kinds: job.input.kinds as CheckKind[] } : {}),
          })),
        };
      case "review":
        return { ...(await review(ctx, s("plan"), s("patch"), s("checks"))) };
      case "check": {
        const repo = expandHome(s("repo") || ctx.project.repos[0]!);
        const id = `check-${Date.now().toString(36)}`;
        const branch = `openhelper/${id}`;
        const dir = createWorktree(repo, headSha(repo), branch, id);
        try {
          const r = await runChecks(dir, ctx.languages, ctx.sandbox, {
            ...(ctx.project.languages.length ? { languages: ctx.project.languages } : {}),
            ...(Array.isArray(job.input.kinds) ? { kinds: job.input.kinds as CheckKind[] } : {}),
            readOnly: [repo],
            onProgress: (x) => log(`check ${x.language}/${x.id}: ${x.status}${x.reason ? ` (${x.reason})` : ""}`),
          });
          return { ...r };
        } finally {
          removeWorktree(repo, dir, branch);
        }
      }
      case "setup":
        // A doc that can't be fetched shouldn't stop the repo from being searchable.
        for (const id of ctx.project.docs) {
          const pack = loadDocPacks().find((p) => p.id === id);
          if (!pack || docStatus(pack).fetched) continue;
          if (!pack.sources.length && !pack.local_command) {
            log(`${id}: download it yourself, add it on the Library page, then rebuild the index`);
            continue;
          }
          try {
            log(`fetched ${await fetchDocPack(pack, log)} files for ${id}`);
          } catch (e) {
            log(`could not fetch ${id}: ${(e as Error).message}; continuing without it`);
          }
        }
        return this.buildProjectIndex(ctx, log);
      case "index":
        return this.buildProjectIndex(ctx, log);
      case "mine": {
        const tasks = mineProject(ctx.project, ctx.languages, { limit: Number(job.input.limit ?? 100) });
        const file = saveTasks(ctx.project.name, tasks);
        log(`mined ${tasks.length} tasks into ${file}`);
        return { tasks: tasks.length, file };
      }
      case "eval": {
        let tasks = loadTasks(ctx.project.name);
        if (!tasks.length) throw new Error("no eval tasks; press Mine eval tasks on the Projects page first");
        const limit = Number(job.input.limit ?? 0);
        if (limit) tasks = tasks.slice(0, limit);
        return { ...(await runEval(ctx, tasks, ctx.languages)) };
      }
      default:
        throw new Error(`unknown job type ${String(job.type)}`);
    }
  }

  private hasModel(id: string): boolean {
    const m = loadModels().find((x) => x.id === id);
    return Boolean(m && existsSync(modelFile(m)));
  }

  /** Points this machine at the starter models, keeping any role whose model is already here. */
  private async useStarterModels(): Promise<void> {
    const rel = `platforms/${this.platform.name}.toml`;
    const [main, embed] = STARTER_MODELS;
    let text = readConfigFile(rel);
    const set = (key: string, value: string) => {
      text = text.replace(new RegExp(`^${key}\\s*=.*$`, "m"), `${key} = "${value}"`);
    };
    if (!this.hasModel(this.platform.model.current)) set("current", main);
    if (!this.hasModel(this.platform.model.light)) set("light", main);
    if (!this.hasModel(this.platform.model.embed)) set("embed", embed);
    const staged = stage(rel, text, (f) => void loadFile(PlatformSchema, f));
    if (!staged.valid) throw new Error(`could not update ${rel}: ${staged.error}`);
    const applied = await apply(rel, async () => {
      this.reload();
      return true;
    });
    if (!applied.applied) throw new Error(`could not update ${rel}: ${applied.error}`);
    // llama-swap watches this file and reloads it.
    const server = join(repoRoot(), "vendor", "llama.cpp", "build", "bin", "llama-server");
    writeFileAtomic(join(ws.root(), "llama-swap.yaml"), llamaSwapConfig(this.platform, loadModels(), server));
  }

  async setupStatus() {
    const models = loadModels();
    const { driver, vm } = this.platform.sandbox;
    const sandbox = driver === "lima" ? await limaState(vm) : driver;
    const model_ready = this.hasModel(this.currentModel) && this.hasModel(this.platform.model.embed);
    const sandbox_ready = driver !== "none" && sandbox !== "missing";
    const all = loadProjects();
    const projects = all.length;
    const indexed = all.filter((p) => existsSync(join(ws.index(p.name), "meta.json"))).length;
    return {
      starter: STARTER_MODELS.flatMap((id) => {
        const m = models.find((x) => x.id === id);
        return m ? [{ id, name: m.name, size_gb: m.size_gb, license: m.license, present: this.hasModel(id) }] : [];
      }),
      model_ready,
      sandbox,
      sandbox_ready,
      projects,
      indexed,
      done: model_ready && sandbox_ready && indexed > 0,
    };
  }

  private async buildProjectIndex(ctx: AgentContext, log: (s: string) => void): Promise<Record<string, unknown>> {
    const embed = this.platform.model.embed;
    return { ...(await buildIndex(ctx.project, { log, ...(embed ? { llm: this.llm, embedModel: embed } : {}) })) };
  }

  async status() {
    const healthy = await this.llm.healthy();
    return {
      platform: this.platform.name,
      description: this.platform.description,
      os: this.platform.os,
      model: this.currentModel,
      default_model: this.platform.model.current,
      loaded: healthy ? await this.llm.running() : [],
      llm_healthy: healthy,
      queue: this.queue.state(),
      sandbox: this.platform.sandbox.driver,
      auto_run: this.platform.auto_run,
      measured: this.platform.measured,
      hw: existsSync(ws.hw()) ? readJson(ws.hw(), {}) : null,
    };
  }
}
