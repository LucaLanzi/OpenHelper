import { join } from "node:path";
import { audit } from "../core/audit.js";
import { ensureDir, listFiles, readJson, writeFileAtomic } from "../core/fsutil.js";
import { canSend, withinBudget } from "../core/links.js";
import { loadLinks, loadPlatforms, loadWorkflows } from "../core/load.js";
import { ws } from "../core/paths.js";
import type { AgentKind, WorkflowDef, WorkflowStep } from "../core/schemas.js";
import { newId, parseDuration, render } from "../core/util.js";
import { resolvePlatform, validateWorkflow } from "../core/workflow-def.js";
import type { Job, JobType } from "../jobs/queue.js";
import type { Runtime } from "../runtime.js";
import { PeerClient } from "./peers.js";

export type RunStatus = "running" | "waiting-approval" | "done" | "failed" | "canceled" | "refused";

export interface StepState {
  id: string;
  platform: string;
  agent: AgentKind;
  status: "pending" | "running" | "waiting-approval" | "done" | "failed" | "skipped" | "refused";
  job_id?: string;
  summary?: string;
  error?: string;
}

export interface WorkflowRun {
  id: string;
  workflow: string;
  project: string;
  inputs: Record<string, string>;
  status: RunStatus;
  steps: StepState[];
  vars: Record<string, string>;
  hops: number;
  tokens: number;
  started_at: string;
  finished_at?: string;
  error?: string;
  /** Text waiting for approval; the person may edit it before approving. */
  gate?: { step: string; content: string };
  /** Time spent waiting for a person; it does not count against the wall-time limit. */
  waited_ms?: number;
}

const AGENT_JOB: Record<AgentKind, JobType> = { planner: "plan", coder: "implement", reviewer: "review", explainer: "explain" };

/** Runs workflows step by step. Cross-platform hand-offs go through the link policy. */
export class WorkflowEngine {
  private runs = new Map<string, WorkflowRun>();
  private aborts = new Map<string, AbortController>();
  private resumes = new Map<string, (r: { approved: boolean; content?: string }) => void>();

  constructor(private rt: Runtime) {
    for (const f of listFiles(join(ws.root(), "runs"), [".json"])) {
      const r = readJson<WorkflowRun | null>(f, null);
      if (!r) continue;
      this.runs.set(r.id, r);
      if (r.status === "running") {
        // The step's job died with the server; there is nothing to pick up.
        r.status = "failed";
        r.error = "server restarted during the run";
        r.finished_at ??= new Date().toISOString();
        const cur = r.steps.find((x) => x.status === "running");
        if (cur) {
          cur.status = "failed";
          cur.error = r.error;
        }
        this.save(r);
      } else if (r.status === "waiting-approval") {
        // Nothing is lost while a run waits for a person, so it keeps waiting.
        this.resumeWaiting(r);
      }
    }
  }

  private resumeWaiting(r: WorkflowRun) {
    const w = loadWorkflows().find((x) => x.name === r.workflow);
    const at = r.steps.findIndex((x) => x.status === "waiting-approval");
    if (!w || at < 0 || w.steps[at]?.id !== r.steps[at]?.id) {
      r.status = "failed";
      r.error = w ? "the workflow changed while the run was waiting" : `workflow "${r.workflow}" no longer exists`;
      r.gate = undefined;
      r.finished_at ??= new Date().toISOString();
      this.save(r);
      return;
    }
    const abort = new AbortController();
    this.aborts.set(r.id, abort);
    void this.execute(w, r, abort.signal, at);
  }

  list(): WorkflowRun[] {
    return [...this.runs.values()].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 100);
  }

  get(id: string): WorkflowRun | undefined {
    return this.runs.get(id);
  }

  private save(r: WorkflowRun) {
    ensureDir(join(ws.root(), "runs"));
    writeFileAtomic(join(ws.root(), "runs", `${r.id}.json`), JSON.stringify(r, null, 2));
    this.rt.queue.emit("run", r);
  }

  start(name: string, project: string, inputs: Record<string, string>, actor = "user"): WorkflowRun {
    const w = loadWorkflows().find((x) => x.name === name);
    if (!w) throw new Error(`no workflow "${name}"`);
    const platforms = loadPlatforms();
    const errors = validateWorkflow(w, platforms, this.rt.config.aliases);
    if (errors.length) throw new Error(`workflow "${name}" is invalid: ${errors.join("; ")}`);
    for (const i of w.inputs) if (!inputs[i]) throw new Error(`missing input "${i}"`);
    const run: WorkflowRun = {
      id: newId("run"),
      workflow: name,
      project,
      inputs,
      status: "running",
      steps: w.steps.map((s) => ({ id: s.id, platform: resolvePlatform(s.platform, this.rt.config.aliases), agent: s.agent, status: "pending" })),
      vars: { ...inputs, project },
      hops: 0,
      tokens: 0,
      started_at: new Date().toISOString(),
    };
    this.runs.set(run.id, run);
    this.save(run);
    audit(actor, "workflow.start", { run: run.id, workflow: name, project });
    const abort = new AbortController();
    this.aborts.set(run.id, abort);
    void this.execute(w, run, abort.signal);
    return run;
  }

  approve(id: string, content?: string, actor = "user"): WorkflowRun {
    const r = this.mustWait(id);
    audit(actor, "workflow.approve", { run: id, step: r.gate?.step, edited: content !== undefined && content !== r.gate?.content });
    this.resumes.get(id)!({ approved: true, ...(content !== undefined ? { content } : {}) });
    return r;
  }

  reject(id: string, actor = "user"): WorkflowRun {
    const r = this.mustWait(id);
    audit(actor, "workflow.reject", { run: id, step: r.gate?.step });
    this.resumes.get(id)!({ approved: false });
    return r;
  }

  cancel(id: string, actor = "user"): WorkflowRun {
    const r = this.runs.get(id);
    if (!r) throw new Error(`no run ${id}`);
    this.aborts.get(id)?.abort();
    this.resumes.get(id)?.({ approved: false });
    if (r.status === "running" || r.status === "waiting-approval") {
      r.status = "canceled";
      r.finished_at = new Date().toISOString();
      this.save(r);
      audit(actor, "workflow.cancel", { run: id });
    }
    return r;
  }

  private mustWait(id: string): WorkflowRun {
    const r = this.runs.get(id);
    if (!r || r.status !== "waiting-approval" || !this.resumes.has(id)) throw new Error(`run ${id} is not waiting for approval`);
    return r;
  }

  /** Runs the steps in order. With `gateAt`, picks up a run that was left waiting at that step's gate. */
  private async execute(w: WorkflowDef, run: WorkflowRun, signal: AbortSignal, gateAt?: number): Promise<void> {
    const deadline = () => Date.parse(run.started_at) + (run.waited_ms ?? 0) + parseDuration(w.limits.max_wall);
    // Launching a workflow is a control-plane action, so the first step needs no link.
    // Every later hand-off between platforms is agent-to-agent and must pass the link policy.
    let prevPlatform = (gateAt ? run.steps[gateAt - 1]?.platform : undefined) ?? run.steps[0]?.platform ?? this.rt.platform.name;
    try {
      for (const [i, step] of w.steps.entries()) {
        if (gateAt !== undefined && i < gateAt) continue;
        if (signal.aborted) return;
        const st = run.steps[i]!;
        if (i !== gateAt) await this.runStep(run, step, st, prevPlatform, deadline(), w, signal);
        if (run.status === "refused") return;

        if (step.gate === "human-approve") {
          if (i !== gateAt) {
            st.status = "waiting-approval";
            run.status = "waiting-approval";
            run.gate = { step: st.id, content: gateContent(step.agent, run, st.id) };
            this.save(run);
          }
          const waitStart = Date.now();
          const decisionGate = await new Promise<{ approved: boolean; content?: string }>((res) => this.resumes.set(run.id, res));
          this.resumes.delete(run.id);
          run.waited_ms = (run.waited_ms ?? 0) + (Date.now() - waitStart);
          if (signal.aborted) return;
          if (!decisionGate.approved) {
            st.status = "failed";
            st.error = "rejected";
            run.status = "canceled";
            run.gate = undefined;
            return;
          }
          if (decisionGate.content !== undefined) {
            // An edited plan replaces the model's plan for every later step.
            run.vars[st.id] = decisionGate.content;
            if (step.agent === "planner") run.vars.plan = decisionGate.content;
          }
          run.gate = undefined;
          run.status = "running";
        }
        st.status = "done";
        prevPlatform = st.platform;
        this.save(run);
      }
      run.status = "done";
    } catch (e) {
      if (run.status === "running" || run.status === "waiting-approval") {
        run.status = signal.aborted ? "canceled" : "failed";
        run.error = (e as Error).message;
        const cur = run.steps.find((s) => s.status === "running" || s.status === "waiting-approval");
        if (cur) {
          cur.status = "failed";
          cur.error = run.error;
        }
      }
    } finally {
      if (!run.finished_at && run.status !== "waiting-approval") run.finished_at = new Date().toISOString();
      this.aborts.delete(run.id);
      this.save(run);
      audit("workflow", `workflow.${run.status}`, { run: run.id, tokens: run.tokens, hops: run.hops });
    }
  }

  /** Checks limits and the link policy, then runs one step's job and collects its output. */
  private async runStep(run: WorkflowRun, step: WorkflowStep, st: StepState, prevPlatform: string, deadline: number, w: WorkflowDef, signal: AbortSignal) {
    if (Date.now() > deadline) throw new Error(`wall-time limit ${w.limits.max_wall} reached`);
    if (run.tokens > w.limits.max_tokens) throw new Error(`token limit ${w.limits.max_tokens} reached`);
    // Link policy for the hand-off from the previous platform to this step's platform.
    const links = loadLinks();
    const decision = canSend(links, prevPlatform, st.platform);
    if (st.platform !== prevPlatform) run.hops++;
    const budget = withinBudget(decision.link, { hops: run.hops, tokens: run.tokens, started_at: Date.parse(run.started_at) + (run.waited_ms ?? 0) });
    if (!decision.allowed || !budget.allowed) {
      st.status = "refused";
      st.error = decision.allowed ? budget.reason : decision.reason;
      run.status = "refused";
      run.error = `step "${st.id}" refused: ${st.error}`;
      audit("workflow", "link.refused", { run: run.id, step: st.id, from: prevPlatform, to: st.platform, reason: st.error });
      return;
    }
    if (st.platform !== prevPlatform) audit("workflow", "link.handoff", { run: run.id, step: st.id, from: prevPlatform, to: st.platform });

    st.status = "running";
    this.save(run);
    const job = await this.dispatch(run, step, st, prevPlatform, signal);
    run.tokens += job.usage.prompt_tokens + job.usage.completion_tokens;
    if (job.status !== "done") throw new Error(`step "${st.id}" ${job.status}: ${job.error ?? ""}`);
    this.collect(run, step, st, job);
  }

  private async dispatch(run: WorkflowRun, step: WorkflowStep, st: StepState, from: string, signal: AbortSignal): Promise<Job> {
    const type = AGENT_JOB[step.agent];
    const task = render(step.prompt, run.vars).replace(/^\/[a-z-]+\s+/i, "");
    const input: Record<string, unknown> = { task, plan: run.vars.plan ?? "", patch: run.vars.patch ?? "", checks: run.vars.checks ?? "" };
    if (step.best_of > 1) input.best_of = step.best_of;
    if (step.checks.length) input.kinds = step.checks;
    const origin = { run_id: run.id, step: st.id, from_platform: from };

    if (st.platform === this.rt.platform.name) {
      const job = this.rt.queue.create({ type, project: run.project, platform: st.platform, model: step.model ?? "", input, origin });
      st.job_id = job.id;
      this.save(run);
      // Starting the workflow counts as starting its jobs.
      this.rt.queue.start(job.id, "workflow");
      const onAbort = () => this.rt.queue.cancel(job.id, "workflow");
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await this.rt.queue.wait(job.id);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }

    const target = loadPlatforms().find((p) => p.name === st.platform);
    if (!target) throw new Error(`unknown platform ${st.platform}`);
    const peer = new PeerClient(target);
    const created = await peer.call<Job>("POST", "/api/inbox/jobs", {
      envelope: { from, run_id: run.id, step: st.id, hops: run.hops, tokens: run.tokens, started_at: run.started_at },
      job: { type, project: run.project, model: step.model ?? "", input },
    });
    st.job_id = created.id;
    this.save(run);
    // Remote platforms may be asleep or busy; poll until the job finishes. No silent re-routing.
    for (;;) {
      if (signal.aborted) {
        await peer.call("POST", `/api/jobs/${created.id}/cancel`).catch(() => {});
        throw new Error("canceled");
      }
      await sleep(2000);
      let j: Job;
      try {
        j = await peer.call<Job>("GET", `/api/jobs/${created.id}`);
      } catch (e) {
        st.summary = `waiting for ${st.platform}: ${(e as Error).message}`;
        this.save(run);
        continue;
      }
      if (["done", "failed", "canceled"].includes(j.status)) return j;
    }
  }

  private collect(run: WorkflowRun, step: WorkflowStep, st: StepState, job: Job) {
    const o = job.output ?? {};
    switch (step.agent) {
      case "planner":
        run.vars.plan = String(o.plan ?? "");
        run.vars[st.id] = run.vars.plan;
        st.summary = `plan ${String(o.file ?? "")}: ${String((o.citations as { valid?: number })?.valid ?? 0)} citations, ${String(o.unverified ?? 0)} unverified`;
        break;
      case "coder": {
        const best = o.best as { diff?: string; branch?: string; confidence?: { status: string; reasons: string[] }; checks?: { language: string; id: string; status: string }[] } | undefined;
        run.vars.patch = best?.diff ?? "";
        run.vars.branch = best?.branch ?? "";
        run.vars.checks = (best?.checks ?? []).map((c) => `${c.language}/${c.id}: ${c.status}`).join("\n");
        run.vars[st.id] = run.vars.patch;
        st.summary = best ? `${best.confidence?.status ?? "?"} on branch ${best.branch}` : "no candidate";
        break;
      }
      case "reviewer":
        run.vars.review = String(o.review ?? "");
        run.vars[st.id] = run.vars.review;
        st.summary = `verdict: ${String(o.verdict ?? "unclear")}`;
        break;
      case "explainer":
        run.vars.answer = String(o.answer ?? "");
        run.vars[st.id] = run.vars.answer;
        st.summary = `${String((o.confidence as { status?: string })?.status ?? "")} answer`;
        break;
    }
  }
}

function gateContent(agent: AgentKind, run: WorkflowRun, stepId: string): string {
  if (agent === "planner") return run.vars.plan ?? "";
  if (agent === "reviewer") return run.vars.review ?? "";
  return run.vars[stepId] ?? "";
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
