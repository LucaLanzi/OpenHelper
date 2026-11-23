import { existsSync } from "node:fs";
import { join } from "node:path";
import { explain, implement, plan, review } from "./agent/agents.js";
import type { AgentContext } from "./agent/context.js";
import { runChecks } from "./checks/runner.js";
import { audit } from "./core/audit.js";
import { readJson, writeFileAtomic } from "./core/fsutil.js";
import { createWorktree, headSha, removeWorktree } from "./core/git.js";
import { findProject, loadConfig, loadDocPacks, loadLanguages, loadModels, loadPlatforms } from "./core/load.js";
import { ws } from "./core/paths.js";
import type { CheckKind, Platform, WorkspaceConfig } from "./core/schemas.js";
import { buildIndex, expandHome } from "./index/build.js";
import { fetchDocPack } from "./index/docs.js";
import { JobQueue, type Job } from "./jobs/queue.js";
import { LlmClient } from "./llm/client.js";
import { runEval } from "./miner/eval.js";
import { loadTasks, mineProject, saveTasks } from "./miner/mine.js";
import { makeSandbox } from "./sandbox/sandbox.js";

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
      case "index": {
        const embed = this.platform.model.embed;
        const meta = await buildIndex(ctx.project, { log, ...(embed ? { llm: this.llm, embedModel: embed } : {}) });
        return { ...meta };
      }
      case "docs": {
        const pack = loadDocPacks().find((p) => p.id === s("pack"));
        if (!pack) throw new Error(`no doc pack ${s("pack")}`);
        return { files: await fetchDocPack(pack, log) };
      }
      case "mine": {
        const tasks = mineProject(ctx.project, ctx.languages, { limit: Number(job.input.limit ?? 100) });
        const file = saveTasks(ctx.project.name, tasks);
        log(`mined ${tasks.length} tasks into ${file}`);
        return { tasks: tasks.length, file };
      }
      case "eval": {
        let tasks = loadTasks(ctx.project.name);
        if (!tasks.length) throw new Error("no eval tasks; run `make mine-evals` first");
        const limit = Number(job.input.limit ?? 0);
        if (limit) tasks = tasks.slice(0, limit);
        return { ...(await runEval(ctx, tasks, ctx.languages)) };
      }
      default:
        throw new Error(`unknown job type ${String(job.type)}`);
    }
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
