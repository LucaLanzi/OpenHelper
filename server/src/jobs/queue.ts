import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { audit } from "../core/audit.js";
import { ensureDir, listFiles, readJson, writeFileAtomic } from "../core/fsutil.js";
import { ws } from "../core/paths.js";
import { newId } from "../core/util.js";

export type JobType = "explain" | "plan" | "implement" | "review" | "check" | "index" | "docs" | "eval" | "mine";
export type JobStatus = "created" | "queued" | "running" | "done" | "failed" | "canceled";

export interface Job {
  id: string;
  type: JobType;
  project: string;
  platform: string;
  model: string;
  status: JobStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  log: string[];
  usage: { prompt_tokens: number; completion_tokens: number };
  created_at: string;
  started_at?: string;
  finished_at?: string;
  /** Set when a workflow run or another platform created the job. */
  origin?: { run_id?: string; step?: string; from_platform?: string };
}

export type JobHandler = (job: Job, log: (s: string) => void, signal: AbortSignal) => Promise<Record<string, unknown>>;

/**
 * One job runs at a time per machine (one model loaded). Jobs are created first and run only when
 * someone starts them: batch work never starts on its own. Model swaps wait for the running job.
 */
export class JobQueue extends EventEmitter {
  private jobs = new Map<string, Job>();
  private order: string[] = [];
  private running?: { id: string; abort: AbortController };
  paused = false;
  pendingSwap?: { model: string; apply: () => Promise<void> };

  constructor(private handler: JobHandler) {
    super();
    this.setMaxListeners(100);
    this.load();
  }

  private file(id: string) {
    return join(ws.jobs(), `${id}.json`);
  }

  private load() {
    for (const f of listFiles(ws.jobs(), [".json"])) {
      const j = readJson<Job | null>(f, null);
      if (!j) continue;
      // A job that was running when the server stopped did not finish.
      if (j.status === "running" || j.status === "queued") {
        j.status = "failed";
        j.error = "server restarted while the job was in progress";
        j.finished_at = new Date().toISOString();
      }
      this.jobs.set(j.id, j);
      this.order.push(j.id);
    }
    this.order.sort((a, b) => this.jobs.get(a)!.created_at.localeCompare(this.jobs.get(b)!.created_at));
  }

  private save(j: Job) {
    ensureDir(ws.jobs());
    writeFileAtomic(this.file(j.id), JSON.stringify(j, null, 2));
    this.emit("job", j);
  }

  create(p: Pick<Job, "type" | "project" | "platform" | "model" | "input"> & { origin?: Job["origin"] }): Job {
    const j: Job = {
      id: newId(p.type),
      type: p.type,
      project: p.project,
      platform: p.platform,
      model: p.model,
      status: "created",
      input: p.input,
      log: [],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      created_at: new Date().toISOString(),
      ...(p.origin ? { origin: p.origin } : {}),
    };
    this.jobs.set(j.id, j);
    this.order.push(j.id);
    this.save(j);
    audit("queue", "job.create", { id: j.id, type: j.type, project: j.project }, j.platform);
    return j;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(limit = 100): Job[] {
    return this.order.slice(-limit).reverse().map((id) => this.jobs.get(id)!);
  }

  start(id: string, actor = "user"): Job {
    const j = this.mustGet(id);
    if (j.status !== "created") throw new Error(`job ${id} is ${j.status}, not created`);
    j.status = "queued";
    this.save(j);
    audit(actor, "job.start", { id }, j.platform);
    void this.pump();
    return j;
  }

  cancel(id: string, actor = "user"): Job {
    const j = this.mustGet(id);
    if (j.status === "running" && this.running?.id === id) this.running.abort.abort();
    if (j.status === "created" || j.status === "queued" || j.status === "running") {
      j.status = "canceled";
      j.finished_at = new Date().toISOString();
      this.save(j);
      audit(actor, "job.cancel", { id }, j.platform);
    }
    return j;
  }

  pause(on: boolean, actor = "user") {
    this.paused = on;
    audit(actor, on ? "queue.pause" : "queue.resume");
    this.emit("queue", this.state());
    if (!on) void this.pump();
  }

  state() {
    return {
      paused: this.paused,
      running: this.running?.id,
      queued: this.order.filter((id) => this.jobs.get(id)!.status === "queued").length,
      pending_swap: this.pendingSwap?.model,
    };
  }

  /** Swap now if idle, otherwise after the running job. */
  async requestSwap(model: string, apply: () => Promise<void>): Promise<"now" | "after-current-job"> {
    if (!this.running) {
      await apply();
      return "now";
    }
    this.pendingSwap = { model, apply };
    this.emit("queue", this.state());
    return "after-current-job";
  }

  /** Wait until a job reaches a final state. */
  wait(id: string, timeoutMs = 24 * 3600_000): Promise<Job> {
    const done = (j: Job) => ["done", "failed", "canceled"].includes(j.status);
    const j0 = this.mustGet(id);
    if (done(j0)) return Promise.resolve(j0);
    return new Promise((resolveWait, reject) => {
      const timer = setTimeout(() => {
        this.off("job", on);
        reject(new Error(`timed out waiting for ${id}`));
      }, timeoutMs);
      const on = (j: Job) => {
        if (j.id === id && done(j)) {
          clearTimeout(timer);
          this.off("job", on);
          resolveWait(j);
        }
      };
      this.on("job", on);
    });
  }

  private mustGet(id: string): Job {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`no job ${id}`);
    return j;
  }

  private async pump(): Promise<void> {
    if (this.running || this.paused) return;
    if (this.pendingSwap) {
      const s = this.pendingSwap;
      this.pendingSwap = undefined;
      try {
        await s.apply();
      } catch (e) {
        audit("queue", "model.swap.failed", { model: s.model, error: (e as Error).message });
      }
    }
    const next = this.order.map((id) => this.jobs.get(id)!).find((j) => j.status === "queued");
    if (!next) return;
    const abort = new AbortController();
    this.running = { id: next.id, abort };
    next.status = "running";
    next.started_at = new Date().toISOString();
    this.save(next);
    const log = (s: string) => {
      const line = `${new Date().toISOString().slice(11, 19)} ${s}`;
      next.log.push(line);
      if (next.log.length > 2000) next.log.splice(0, next.log.length - 2000);
      this.emit("log", next.id, line);
    };
    try {
      const out = await this.handler(next, log, abort.signal);
      if (next.status === "running") {
        next.status = "done";
        next.output = out;
      }
    } catch (e) {
      if (next.status === "running") {
        next.status = abort.signal.aborted ? "canceled" : "failed";
        next.error = (e as Error).message;
        log(`error: ${next.error}`);
      }
    } finally {
      next.finished_at = new Date().toISOString();
      this.running = undefined;
      this.save(next);
      audit("queue", `job.${next.status}`, { id: next.id, type: next.type, tokens: next.usage }, next.platform);
      setImmediate(() => void this.pump());
    }
  }
}

export function jobExists(id: string): boolean {
  return existsSync(join(ws.jobs(), `${id}.json`));
}
