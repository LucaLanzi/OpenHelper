import { assertAgent, runRemote } from "./hooks.js";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { explain, implement, plan, review } from "./agent/agents.js";
import type { AgentContext } from "./agent/context.js";
import { runChecks } from "./checks/runner.js";
import { audit } from "./core/audit.js";
import { readJson, writeFileAtomic } from "./core/fsutil.js";
import { createWorktree, headSha, removeWorktree } from "./core/git.js";
import { findModel, findProject, loadConfig, loadDocPacks, loadFile, loadLanguages, loadModels, loadPlatforms, loadProjects } from "./core/load.js";
import { repoRoot, ws } from "./core/paths.js";
import { Platform as PlatformSchema } from "./core/schemas.js";
import type { CheckKind, Platform, Project, WorkspaceConfig } from "./core/schemas.js";
import { apply, readConfigFile, stage } from "./core/staging.js";
import { embeddingModel, estimateIndex, liveEta, recordTiming, workload } from "./index/estimate.js";
import { buildIndex, expandHome } from "./index/build.js";
import { addLocalDocs, docStatus, fetchDocPack } from "./index/docs.js";
import { JobQueue, type Job } from "./jobs/queue.js";
import { LlmClient } from "./llm/client.js";
import { runEval } from "./miner/eval.js";
import { loadTasks, mineProject, saveTasks } from "./miner/mine.js";
import { limaPower, limaState, makeSandbox } from "./sandbox/sandbox.js";
import { runScript, STARTER_MODELS } from "./setup.js";
import { llamaSwapConfig, modelFile } from "./swapconfig.js";

interface State {
  current_model?: string;
}

/** Everything one machine runs: its platform config, model server client, sandbox and job queue. */
/** The project's own choice first, then this platform's. A blank light model means the platform's light model. */
export function projectModel(p: Project, platform: Platform, current: string, light = false): string {
  return (light && (p.light_model || platform.model.light)) || p.model || current;
}

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

  /** Dashboards open right now, counted by their event streams. */
  dashboards = 0;
  private idleSince = Date.now();
  private vmStopped = false;

  /**
   * True once, when no dashboard has been open and no job active for unload_after_min:
   * time to stop the sandbox VM, which a job starts again when it needs it.
   * Models unload on the same timer in llama-swap (its ttl), so nothing big keeps running.
   * ponytail: an editor's MCP run_checks is not counted; its VM may stop mid-check if no dashboard is open.
   */
  idleVmStop(now = Date.now()): boolean {
    if (this.dashboards > 0 || this.queue.hasActive()) { this.idleSince = now; this.vmStopped = false; return false; }
    if (this.platform.sandbox.driver !== "lima" || this.vmStopped || now - this.idleSince < this.platform.resources.unload_after_min * 60_000) return false;
    return (this.vmStopped = true);
  }

  /** `serve` runs this; tests don't. */
  watchIdle(): void {
    setInterval(() => {
      if (!this.idleVmStop()) return;
      const { vm } = this.platform.sandbox;
      void limaState(vm)
        .then(async (s) => { if (s === "Running") { await limaPower(vm, false); audit("system", "sandbox.idle-stop", { vm }, this.platform.name); } })
        .catch((e: Error) => audit("system", "sandbox.idle-stop-failed", { vm, error: e.message }, this.platform.name));
    }, 60_000).unref();
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
    const project = job.project_config ?? findProject(job.project);
    return {
      config: this.config,
      platform: this.platform,
      project,
      llm: this.llm,
      model: job.model || projectModel(project, this.platform, this.currentModel, job.type === "explain" && job.input.light === true),
      ...(embeddingModel(project, this.platform) ? { embedModel: embeddingModel(project, this.platform) } : {}),
      sandbox: makeSandbox(this.platform.sandbox),
      languages: loadLanguages().filter(l => project.language_mode !== "selected" || project.languages.includes(l.id)).map(l => ({ ...l, checks: l.checks.filter(c => !project.checks || project.checks.includes(`${l.id}/${c.id}`)) })),
      log,
      signal,
      usage: job.usage,
    };
  }

  private async handle(job: Job, log: (s: string) => void, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (job.platform !== this.platform.name) return runRemote(this, job, log, signal);
    assertAgent(this, job.type);
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
    if (job.type === "model-download") {
      const id = String(job.input.id);
      const url = typeof job.input.url === "string" ? job.input.url : "";
      await runScript("download-model.sh", url ? [id, url] : [id], { OH_YES: "1" }, log, signal);
      this.writeSwapConfig();
      return { id };
    }
    if (job.type === "bench") {
      const id = String(job.input.id);
      await this.llm.unloadAll();
      const table: string[] = [];
      const keep = (line: string) => {
        if (line.startsWith("|")) table.push(line);
        log(line);
      };
      await runScript("bench.sh", [], { MODEL_FILE: modelFile(findModel(id)) }, keep, signal);
      return { id, table };
    }
    if (job.type === "tune") {
      await this.llm.unloadAll();
      await runScript("tune.sh", [String(job.input.id)], {}, log, signal);
      return { id: String(job.input.id) };
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
        return this.buildProjectIndex(ctx, log, job);
      case "index":
        return this.buildProjectIndex(ctx, log, job);
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

  /** Deletes a downloaded model's file and any partial download. Its pack stays, so it can be downloaded again. */
  deleteModelFile(id: string): { file: string; freed_bytes: number } {
    const m = loadModels().find((x) => x.id === id);
    if (!m) throw new Error(`no model ${id}`);
    const uses = this.modelsOverview().find((x) => x.id === id)!.uses;
    if (uses.length) throw new Error(`${m.name} is this machine's ${uses.join(" and ")} model. Choose another model for that first.`);
    if (this.queue.list(Number.MAX_SAFE_INTEGER).some((j) => ["created", "queued", "running"].includes(j.status) && j.input.id === id && ["model-download", "bench", "tune"].includes(j.type)))
      throw new Error(`a job is using ${m.name}; wait for it or cancel it on the Jobs page`);
    const file = modelFile(m);
    let freed_bytes = 0;
    for (const f of [file, `${file}.part`]) {
      if (!existsSync(f)) continue;
      freed_bytes += statSync(f).size;
      rmSync(f);
    }
    if (!freed_bytes) throw new Error(`${m.name} is not downloaded`);
    return { file, freed_bytes };
  }

  private hasModel(id: string): boolean {
    const m = loadModels().find((x) => x.id === id);
    return Boolean(m && existsSync(modelFile(m)));
  }

  /** Points this machine at the starter models, keeping any role whose model is already here. */
  private async useStarterModels(): Promise<void> {
    const [main, embed] = STARTER_MODELS;
    await this.setModelRoles({
      ...(this.hasModel(this.platform.model.current) ? {} : { current: main }),
      ...(this.hasModel(this.platform.model.light) ? {} : { light: main }),
      ...(this.hasModel(this.platform.model.embed) ? {} : { embed }),
    });
  }

  /** Writes which model does which job to the platform file, keeping a backup. */
  private async setModelRoles(roles: Partial<Record<"current" | "light" | "embed", string>>): Promise<void> {
    const rel = `platforms/${this.platform.name}.toml`;
    let text = readConfigFile(rel);
    for (const [key, id] of Object.entries(roles)) {
      text = text.replace(new RegExp(`^${key}\\s*=.*$`, "m"), `${key} = "${id}"`);
      // An empty list means every model is offered.
      if (key !== "embed" && this.platform.model.allowed.length && !this.platform.model.allowed.includes(id)) {
        text = text.replace(/^allowed\s*=\s*\[/m, `allowed = ["${id}", `);
      }
    }
    const staged = stage(rel, text, (f) => void loadFile(PlatformSchema, f));
    if (!staged.valid) throw new Error(`could not update ${rel}: ${staged.error}`);
    const applied = await apply(rel, async () => {
      this.reload();
      return true;
    });
    if (!applied.applied) throw new Error(`could not update ${rel}: ${applied.error}`);
    this.writeSwapConfig();
  }

  /** llama-swap watches this file and reloads it. */
  private writeSwapConfig(): void {
    const server = join(repoRoot(), "vendor", "llama.cpp", "build", "bin", "llama-server");
    writeFileAtomic(join(ws.root(), "llama-swap.yaml"), llamaSwapConfig(this.platform, loadModels(), server));
  }

  /** Gives a downloaded model a job: main, light, or search embeddings. */
  async useModel(id: string, role: "main" | "light" | "embed"): Promise<void> {
    if (!this.hasModel(id)) throw new Error(`${id} is not downloaded yet`);
    const m = findModel(id);
    if ((role === "embed") !== m.roles.includes("embed")) throw new Error(role === "embed" ? `${id} is not an embedding model` : `${id} is an embedding model`);
    await this.setModelRoles({ [role === "main" ? "current" : role]: id });
    if (role === "main") await this.swapModel(id);
  }

  modelsOverview() {
    const { light, embed } = this.platform.model;
    const hw = readJson<{ gpu?: { vendor?: string } }>(ws.hw(), {});
    return loadModels().map((m) => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      quant: m.quant,
      size_gb: m.size_gb,
      roles: m.roles,
      license: m.license,
      present: this.hasModel(m.id),
      pinned: Boolean(m.sha256),
      has_source: Boolean(m.source.url || (m.source.hf_repo && m.source.filename)),
      uses: [...(m.id === this.currentModel ? ["main"] : []), ...(m.id === light ? ["light"] : []), ...(m.id === embed ? ["embed"] : [])],
      can_tune: m.kind === "moe" && hw.gpu?.vendor === "nvidia",
    }));
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

  private async buildProjectIndex(ctx: AgentContext, log: (s: string) => void, job: Job): Promise<Record<string, unknown>> {
    const embed = embeddingModel(ctx.project, this.platform);
    if (ctx.project.search === "hybrid" && !embed) throw new Error("Choose an embedding model for hybrid search");
    const estimate = estimateIndex(this.platform, workload(ctx.project), embed);
    const started = Date.now();
    let base: { elapsed_ms: number; done: number } | undefined;
    const meta = await buildIndex(ctx.project, { log, signal: ctx.signal, ...(embed ? { llm: this.llm, embedModel: embed } : {}), progress: p => {
      if (!base && p.phase === "embedding" && p.embeddings_completed > 0) base = { elapsed_ms: p.elapsed_ms, done: p.embeddings_completed };
      const [eta_min_s, eta_max_s] = liveEta(p, estimate, base);
      this.queue.updateProgress(job.id, { ...p, eta_min_s, eta_max_s });
    }});
    // A fallback keyword build is not a successful sample for the requested embedding model,
    // and a mostly cached rebuild says little about how fast this machine embeds.
    if (!embed || (meta.embed_model === embed && (meta.embedded ?? 0) >= meta.chunks / 2)) recordTiming({ platform: this.platform.name, embed_model: embed, files: job.progress?.files_processed ?? 0, chunks: meta.chunks, duration_ms: Date.now()-started, at: new Date().toISOString() });
    return { ...meta, duration_ms: Date.now()-started, files: job.progress?.files_processed ?? 0 };
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
      active_projects: [...new Set(this.queue.list(Number.MAX_SAFE_INTEGER).filter(j => ["queued","running"].includes(j.status) || this.queue.state().running === j.id).map(j => j.project))],
      sandbox: this.platform.sandbox.driver,
      auto_run: this.platform.auto_run,
      measured: this.platform.measured,
      hw: existsSync(ws.hw()) ? readJson(ws.hw(), {}) : null,
    };
  }
}
