import { ZodError } from "zod";
import { managementRoutes, healthRecord, rememberHealth } from "./management-routes.js";
import { assertAgent } from "./hooks.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { formatPassages, retrieve } from "./agent/context.js";
import { audit, readAudit, verifyAudit } from "./core/audit.js";
import { assess, countValidCitations } from "./core/confidence.js";
import { listFiles, readText, writeFileAtomic } from "./core/fsutil.js";
import { canSend, matrix, withinBudget } from "./core/links.js";
import {
  findModel,
  findProject,
  loadConfig,
  loadDocPacks,
  loadFile,
  loadLanguages,
  loadLinks,
  loadPlatforms,
  loadProjects,
  loadTemplate,
  loadWorkflows,
} from "./core/load.js";
import { repoRoot, ws } from "./core/paths.js";
import { LinksFile, ModelRole, Platform, Project, WorkflowDef, WorkspaceConfig } from "./core/schemas.js";
import { apiToken } from "./core/secrets.js";
import { apply, history, readConfigFile, restore, stage } from "./core/staging.js";
import { render, safeEqual } from "./core/util.js";
import { validateWorkflow } from "./core/workflow-def.js";
import { expandHome, openIndex } from "./index/build.js";
import { docStatus } from "./index/docs.js";
import type { Job, JobType } from "./jobs/queue.js";
import { loadTasks } from "./miner/mine.js";
import { addLanguagePack, addModelPack, redetected } from "./packs.js";
import { addProject, pickPath } from "./projects.js";
import { projectModel, Runtime } from "./runtime.js";
import { limaPower, limaState, makeSandbox } from "./sandbox/sandbox.js";
import { redeemLoginCode, runDetached } from "./setup.js";
import { WorkflowEngine } from "./workflow/engine.js";
import { PeerClient } from "./workflow/peers.js";

const VERSION = "0.0.1";
const JOB_TYPES: JobType[] = ["explain", "plan", "implement", "review", "check", "index", "docs", "eval", "mine"];

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function bad(msg: string): never {
  throw new HttpError(400, msg);
}

function body<T extends Record<string, unknown>>(req: FastifyRequest): T {
  return (req.body ?? {}) as T;
}

export interface App {
  app: FastifyInstance;
  rt: Runtime;
  engine: WorkflowEngine;
}

export async function buildApp(opts: { logger?: boolean } = {}): Promise<App> {
  const rt = new Runtime();
  const engine = new WorkflowEngine(rt);
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 8 * 1024 * 1024 });
  const roles = new Set(rt.config.roles);

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof HttpError ? err.status : err instanceof ZodError ? 400 : (err.statusCode ?? 500);
    void reply.status(status).send({ error: err.message });
  });

  // --- auth: every /api route except health needs the bearer token -------------------------
  app.addHook("onRequest", async (req, reply) => {
    // /api/login takes a one-time code instead, and only from this machine.
    if (!req.url.startsWith("/api/") || req.url === "/api/health" || req.url === "/api/login") return;
    const header = req.headers.authorization ?? "";
    // EventSource cannot send headers, so the event stream alone accepts ?token=.
    const q = req.url.startsWith("/api/events") ? new URL(req.url, "http://x").searchParams.get("token") ?? "" : "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : q;
    if (!given || !safeEqual(given, apiToken())) {
      await reply.status(401).send({ error: "missing or wrong token" });
    }
  });

  managementRoutes(app, rt, engine);

  app.get("/api/health", async () => ({ ok: true, platform: rt.platform.name, version: VERSION, roles: [...roles] }));

  // ===================================================================== node (data plane)
  app.get("/api/status", async () => rt.status());

  app.get("/api/models", async () => ({
    current: rt.currentModel,
    default: rt.platform.model.current,
    light: rt.platform.model.light,
    pending_swap: rt.queue.pendingSwap?.model ?? null,
    models: rt.pickerModels(),
    results: latestResults(),
  }));

  app.post("/api/models/swap", async (req) => {
    const { model } = body<{ model?: string }>(req);
    if (!model) bad("model is required");
    return { model, when: await rt.swapModel(model) };
  });

  app.get("/api/jobs", async () => rt.queue.list().map(summarizeJob));
  app.get("/api/jobs/:id", async (req) => {
    const j = rt.queue.get((req.params as { id: string }).id);
    if (!j) throw new HttpError(404, "no such job");
    return j;
  });

  app.post("/api/jobs", async (req) => {
    const b = body<{ type?: JobType; project?: string; input?: Record<string, unknown>; model?: string; start?: boolean }>(req);
    if (!b.type || !JOB_TYPES.includes(b.type)) bad(`type must be one of ${JOB_TYPES.join(", ")}`);
    // Fetching a doc pack is the one job that belongs to no project.
    if (b.type !== "docs") {
      if (!b.project) bad("project is required");
      findProject(b.project);
    }
    assertAgent(rt, b.type);
    const job = rt.queue.create({ type: b.type, project: b.project ?? "", platform: b.project ? findProject(b.project).platform || rt.platform.name : rt.platform.name, model: b.model ?? "", input: b.input ?? {} });
    // Batch jobs only run when a person starts them; `start: true` is that person pressing Start.
    if (b.start) rt.queue.start(job.id);
    return job;
  });
  app.post("/api/jobs/:id/start", async (req) => { const id = (req.params as {id:string}).id; const job = rt.queue.get(id); if (job?.project) findProject(job.project); return rt.queue.start(id); });
  app.post("/api/jobs/:id/cancel", async (req) => rt.queue.cancel((req.params as { id: string }).id));
  app.post("/api/queue", async (req) => {
    rt.queue.pause(Boolean(body<{ paused?: boolean }>(req).paused));
    return rt.queue.state();
  });

  /** Another platform hands work to this one. The link policy is checked here too. */
  app.post("/api/inbox/jobs", async (req) => {
    const b = body<{
      envelope?: { from: string; run_id: string; step: string; hops: number; tokens: number; started_at: string };
      job?: { type: JobType; project: string; model?: string; input: Record<string, unknown> };
    }>(req);
    const env = b.envelope;
    if (!env || !b.job) bad("envelope and job are required");
    const links = loadLinks();
    const d = canSend(links, env.from, rt.platform.name);
    const budget = withinBudget(d.link, { hops: env.hops, tokens: env.tokens, started_at: Date.parse(env.started_at) });
    if (!d.allowed || !budget.allowed) {
      audit(env.from, "inbox.refused", { run: env.run_id, step: env.step, reason: d.allowed ? budget.reason : d.reason }, rt.platform.name);
      throw new HttpError(403, d.allowed ? budget.reason : d.reason);
    }
    if (!JOB_TYPES.includes(b.job.type)) bad("bad job type");
    assertAgent(rt, b.job.type);
    if (![env.hops, env.tokens, Date.parse(env.started_at)].every(Number.isFinite) || env.hops < 0 || env.tokens < 0) bad("invalid budget envelope");
    findProject(b.job.project);
    const job = rt.queue.create({
      type: b.job.type,
      project: b.job.project,
      platform: rt.platform.name,
      model: b.job.model ?? "",
      input: b.job.input,
      origin: { run_id: env.run_id, step: env.step, from_platform: env.from },
    });
    audit(env.from, "inbox.accepted", { run: env.run_id, step: env.step, job: job.id }, rt.platform.name);
    // A workflow run someone started counts as starting this job.
    rt.queue.start(job.id, `workflow@${env.from}`);
    return job;
  });

  app.get("/api/project-options", async () => ({
    self: rt.platform.name, platforms: loadPlatforms(), models: rt.modelsOverview(),
    docs: loadDocPacks().map(p => ({...p,status:docStatus(p)})),
    languages: loadLanguages().map(l => ({id:l.id,name:l.name,detect:l.detect,checks:l.checks.map(c=>c.name),details:l.checks.map(({id,name,kind,requires,when_files})=>({id,name,kind,requires,when_files})),sandbox:rt.platform.sandbox.driver})),
  }));

  app.get("/api/projects", async () =>
    loadProjects().map((p) => ({
      ...p,
      index: openIndex(p.name)?.meta ?? null,
      eval_tasks: loadTasks(p.name).length,
    })),
  );

  // These read paths on this machine, so a token used from another device can't reach them.
  const isLocal = (req: FastifyRequest) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip);
  const localOnly = (req: FastifyRequest) => {
    if (!isLocal(req)) throw new HttpError(403, "open the dashboard on this machine to do this");
  };

  app.get("/api/host", async (req) => ({ local: isLocal(req), picker: isLocal(req) && process.platform === "darwin" }));

  app.post("/api/login", async (req) => {
    localOnly(req);
    const { code } = body<{ code?: string }>(req);
    if (!code || !redeemLoginCode(code)) throw new HttpError(401, "that sign-in link has expired or was already used");
    audit("user", "login.link");
    return { token: apiToken() };
  });

  app.get("/api/setup", async () => rt.setupStatus());

  for (const [path, type] of [["/api/setup/model", "setup-model"], ["/api/setup/sandbox", "setup-sandbox"]] as const) {
    app.post(path, async (req) => {
      localOnly(req);
      const job = rt.queue.create({ type, project: "", platform: rt.platform.name, model: "", input: {} });
      rt.queue.start(job.id);
      return job;
    });
  }

  app.post("/api/pick", async (req) => {
    localOnly(req);
    if (process.platform !== "darwin") throw new HttpError(501, "type the path instead");
    return { path: await pickPath(body<{ kind?: string }>(req).kind === "file" ? "file" : "folder") };
  });

  app.post("/api/projects", async (req) => {
    localOnly(req);
    const b = body<{ path?: string; name?: string }>(req);
    if (!b.path?.trim()) bad("choose a folder");
    let project;
    try {
      project = addProject(b.path.trim(), b.name);
    } catch (e) {
      bad((e as Error).message);
    }
    audit("user", "project.add", { project: project.name });
    const job = rt.queue.create({ type: "setup", project: project.name, platform: rt.platform.name, model: "", input: {} });
    rt.queue.start(job.id);
    return { project, job };
  });

  // --- models ------------------------------------------------------------------------------
  const paramId = (req: FastifyRequest) => (req.params as { id: string }).id;
  const startJob = (type: JobType, input: Record<string, unknown>) => {
    const job = rt.queue.create({ type, project: "", platform: rt.platform.name, model: "", input });
    rt.queue.start(job.id);
    return job;
  };
  const clientError = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      bad((e as Error).message);
    }
  };

  app.get("/api/models/all", async () => rt.modelsOverview());

  app.post("/api/models/add", async (req) => {
    localOnly(req);
    const b = body<{ url?: string; name?: string; size_gb?: number; role?: string; license?: string }>(req);
    const role = ModelRole.safeParse(b.role ?? "main");
    if (!role.success) bad("role must be main, light, reviewer, draft or embed");
    const pack = clientError(() => addModelPack({ url: b.url ?? "", size_gb: Number(b.size_gb), role: role.data, ...(b.name ? { name: b.name } : {}), ...(b.license ? { license: b.license } : {}) }));
    audit("user", "model.add", { model: pack.id });
    return { id: pack.id };
  });

  app.post("/api/models/:id/download", async (req) => {
    localOnly(req);
    const m = clientError(() => findModel(paramId(req)));
    const url = body<{ url?: string }>(req).url?.trim();
    if (url && !url.startsWith("https://")) bad("the link must start with https://");
    if (!url && !m.source.url && !(m.source.hf_repo && m.source.filename)) bad("paste a link to the .gguf file");
    audit("user", "model.download", { model: m.id });
    return startJob("model-download", { id: m.id, ...(url ? { url } : {}) });
  });

  app.post("/api/models/:id/use", async (req) => {
    localOnly(req);
    const role = body<{ role?: string }>(req).role;
    if (role !== "main" && role !== "light" && role !== "embed") bad("role must be main, light or embed");
    try {
      await rt.useModel(paramId(req), role);
    } catch (e) {
      bad((e as Error).message);
    }
    audit("user", "model.use", { model: paramId(req), role });
    return { ok: true };
  });

  // Frees disk space; the model stays listed so it can be downloaded again.
  app.delete("/api/models/:id/file", async (req) => {
    localOnly(req);
    if (body<{ confirm?: boolean }>(req).confirm !== true) bad("confirm the deletion");
    const r = clientError(() => rt.deleteModelFile(paramId(req)));
    audit("user", "model.delete_file", { model: paramId(req), freed_bytes: r.freed_bytes });
    return { ok: true, freed_bytes: r.freed_bytes };
  });

  for (const type of ["bench", "tune"] as const) {
    app.post(`/api/models/:id/${type}`, async (req) => {
      localOnly(req);
      const info = rt.modelsOverview().find((m) => m.id === paramId(req));
      if (!info?.present) bad("download the model first");
      if (type === "tune" && !info.can_tune) bad("tuning is for MoE models on an NVIDIA GPU");
      return startJob(type, { id: info.id });
    });
  }

  // --- languages ---------------------------------------------------------------------------
  app.get("/api/languages", async () =>
    loadLanguages().map((l) => ({ id: l.id, name: l.name, detect: l.detect, checks: l.checks.map((c) => c.name), details: l.checks.map(({ id, name, kind, requires, when_files }) => ({ id, name, kind, requires, when_files })), sandbox: rt.platform.sandbox.driver })),
  );

  // A language's test command runs on this machine when no sandbox is set up.
  app.post("/api/languages", async (req) => {
    localOnly(req);
    const b = body<{ name?: string; extensions?: string; test?: string }>(req);
    const pack = clientError(() => addLanguagePack({ name: b.name ?? "", extensions: b.extensions ?? "", ...(b.test ? { test: b.test } : {}) }));
    audit("user", "language.add", { language: pack.id });
    return { id: pack.id };
  });

  app.post("/api/projects/:id/detect", async (req) => {
    localOnly(req);
    const project = clientError(() => findProject(paramId(req)));
    const rel = `projects/${project.name}.toml`;
    const staged = stage(rel, redetected(project), (f) => void loadFile(Project, f));
    if (!staged.valid) bad(staged.error ?? "could not update the project");
    const applied = await apply(rel, async () => true);
    if (!applied.applied) bad(applied.error ?? "could not update the project");
    audit("user", "project.detect", { project: project.name });
    return { languages: findProject(project.name).languages, docs: findProject(project.name).docs };
  });

  // --- this machine ------------------------------------------------------------------------
  app.get("/api/system", async () => {
    const logFile = join(ws.root(), "logs", "system.log");
    const git = (...args: string[]) => {
      try {
        return execFileSync("git", args, { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return "";
      }
    };
    return {
      version: VERSION,
      commit: git("rev-parse", "--short", "HEAD"),
      branch: git("branch", "--show-current"),
      log: existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").slice(-12).join("\n").trim() : "",
    };
  });

  for (const [action, script] of [["restart", "restart.sh"], ["update", "update.sh"]] as const) {
    app.post(`/api/system/${action}`, async (req) => {
      localOnly(req);
      if (rt.queue.state().running) throw new HttpError(409, "a job is running; try again after it finishes");
      audit("user", `system.${action}`);
      runDetached(script);
      return { started: true };
    });
  }

  app.post("/api/docs/:id/local", async (req) => {
    localOnly(req);
    const id = (req.params as { id: string }).id;
    const path = body<{ path?: string }>(req).path?.trim();
    if (!loadDocPacks().some((p) => p.id === id)) throw new HttpError(404, "no such doc pack");
    if (!path) bad("choose a file or folder");
    if (!existsSync(expandHome(path))) bad(`${path} does not exist`);
    audit("user", "docs.add-local", { pack: id });
    const job = rt.queue.create({ type: "docs-local", project: "", platform: rt.platform.name, model: "", input: { pack: id, path } });
    rt.queue.start(job.id);
    return job;
  });

  app.get("/api/sandbox", async () => {
    const { driver, vm } = rt.platform.sandbox;
    return { driver, state: driver === "lima" ? await limaState(vm) : driver === "none" ? "none" : "available" };
  });

  app.post("/api/sandbox", async (req) => {
    const { driver, vm } = rt.platform.sandbox;
    if (driver !== "lima") throw new HttpError(409, "only the Lima VM can be started and stopped here");
    const on = body<{ on?: boolean }>(req).on === true;
    if (!on && rt.queue.state().running) throw new HttpError(409, "a job is running; stop the VM after it finishes");
    await limaPower(vm, on);
    audit("user", on ? "sandbox.start" : "sandbox.stop", { vm });
    return { driver, state: await limaState(vm) };
  });

  app.post("/api/search", async (req) => {
    const b = body<{ project?: string; q?: string; k?: number }>(req);
    if (!b.project || !b.q) bad("project and q are required");
    const idx = openIndex(b.project);
    if (!idx) throw new HttpError(409, "project is not indexed yet");
    return idx.search(b.q, Math.min(50, b.k ?? 10)).map((c) => ({ ...c, text: c.text.slice(0, 2000) }));
  });

  /** Interactive, grounded Q&A, streamed as server-sent events. */
  app.post("/api/chat", async (req, reply) => {
    const b = body<{ project?: string; message?: string; model?: string; light?: boolean }>(req);
    if (!b.project || !b.message) bad("project and message are required");
    const project = findProject(b.project);
    if (project.platform && project.platform !== rt.platform.name) throw new HttpError(409, "Use an Answer a question job for this remote project; live chat runs on this instance only");
    const model = b.model || projectModel(project, rt.platform, rt.currentModel, b.light === true);
    const logs: string[] = [];
    const ctx = {
      config: rt.config,
      platform: rt.platform,
      project,
      llm: rt.llm,
      model,
      sandbox: makeSandbox(rt.platform.sandbox),
      languages: [],
      log: (s: string) => logs.push(s),
      signal: AbortSignal.timeout(20 * 60_000),
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    };
    const ps = await retrieve(ctx, b.message);
    const prompt = render(loadTemplate("explain"), { project: project.name, task: b.message, context: formatPassages(ps) });
    sse(reply);
    send(reply, "sources", ps.map((p) => ({ label: p.label, source: p.chunk.source, path: p.chunk.path, start_line: p.chunk.start_line, end_line: p.chunk.end_line })));
    let answer = "";
    try {
      for await (const d of rt.llm.chatStream({
        model,
        reasoning: rt.config.reasoning.explain,
        max_tokens: rt.config.max_tokens,
        messages: [
          { role: "system", content: "You are OpenHelper, a careful local coding assistant. Never invent APIs. Cite context passages like [S1]." },
          { role: "user", content: prompt },
        ],
      })) {
        answer += d;
        send(reply, "delta", d);
      }
      const citations = countValidCitations(answer, ps.length);
      const confidence = assess([], { needsCitations: true, citations: citations.valid });
      if (citations.invalid) {
        confidence.status = confidence.status === "green" ? "amber" : confidence.status;
        confidence.reasons.push(`${citations.invalid} citation(s) point at sources that were not supplied`);
      }
      send(reply, "done", { model, citations, confidence, notes: logs });
    } catch (e) {
      send(reply, "error", { error: (e as Error).message });
    }
    reply.raw.end();
    return reply;
  });

  app.get("/api/docs", async () => loadDocPacks().map((p) => ({ ...p, status: docStatus(p) })));

  // Plans: read, edit, approve. Approval is what lets a coder step run.
  app.get("/api/plans", async () =>
    listFiles(ws.plans(), [".md"])
      .reverse()
      .map((f) => {
        const text = readText(f);
        return { name: f.split(/[\\/]/).pop()!, status: /status:\s*(\w+)/.exec(text)?.[1] ?? "draft", title: /^#\s+(.+)$/m.exec(text)?.[1] ?? "" };
      }),
  );
  app.get("/api/plans/:name", async (req) => ({ name: planName(req), content: readText(join(ws.plans(), planName(req))) }));
  app.put("/api/plans/:name", async (req) => {
    const c = body<{ content?: string }>(req).content;
    if (typeof c !== "string") bad("content is required");
    writeFileAtomic(join(ws.plans(), planName(req)), c);
    audit("user", "plan.edit", { plan: planName(req) });
    return { ok: true };
  });
  app.post("/api/plans/:name/approve", async (req) => {
    const f = join(ws.plans(), planName(req));
    writeFileAtomic(f, readText(f).replace(/status:\s*\w+/, "status: approved"));
    audit("user", "plan.approve", { plan: planName(req) });
    return { ok: true };
  });

  app.get("/api/results/:project", async (req) => {
    const dir = join(ws.results(), (req.params as { project: string }).project);
    return listFiles(dir, [".json"])
      .reverse()
      .slice(0, 20)
      .map((f) => {
        const { results: _r, ...summary } = JSON.parse(readText(f)) as Record<string, unknown>;
        return summary;
      });
  });

  app.get("/api/events", async (req, reply) => {
    sse(reply);
    const onJob = (j: Job) => send(reply, "job", summarizeJob(j));
    const onLog = (id: string, line: string) => send(reply, "log", { id, line });
    const onRun = (r: unknown) => send(reply, "run", r);
    const onQueue = (s: unknown) => send(reply, "queue", s);
    rt.queue.on("job", onJob);
    rt.queue.on("log", onLog);
    rt.queue.on("run", onRun);
    rt.queue.on("queue", onQueue);
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 20_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      rt.queue.off("job", onJob);
      rt.queue.off("log", onLog);
      rt.queue.off("run", onRun);
      rt.queue.off("queue", onQueue);
    });
    return reply;
  });

  // ===================================================================== control plane
  if (roles.has("control")) {
    app.get("/api/platforms", async () => {
      const platforms = loadPlatforms();
      return Promise.all(
        platforms.map(async (p) => {
          if (p.name === rt.platform.name) return { ...p, ...rememberHealth(p.name), self: true, reachable: true, status: await rt.status() };
          const peer = new PeerClient(p);
          try {
            const status = await peer.call("GET", "/api/status", undefined, 4000);
            return { ...p, ...rememberHealth(p.name), self: false, reachable: true, status };
          } catch (e) {
            return { ...p, ...healthRecord(p.name), self: false, reachable: false, error: "API unavailable or authentication failed" };
          }
        }),
      );
    });

    app.get("/api/links", async () => {
      const file = loadLinks();
      return { ...file, matrix: matrix(file, loadPlatforms().map((p) => p.name)) };
    });

    app.post("/api/kill-switch", async (req) => {
      const on = Boolean(body<{ on?: boolean }>(req).on);
      const current = existsSync(ws.links()) ? readText(ws.links()) : "kill_switch = false\n";
      const next = /kill_switch\s*=/.test(current) ? current.replace(/kill_switch\s*=\s*\w+/, `kill_switch = ${on}`) : `kill_switch = ${on}\n${current}`;
      stage("links.toml", next, (f) => loadFile(LinksFile, f));
      const r = await apply("links.toml", async () => healthAfterChange(rt));
      audit("user", on ? "kill-switch.on" : "kill-switch.off");
      return r;
    });

    app.get("/api/config", async (req) => {
      const file = (req.query as { file?: string }).file ?? "";
      return { file, content: readConfigFile(file) };
    });
    app.get("/api/config/files", async () => [
      "config.toml",
      "links.toml",
      ...listFiles(ws.platforms(), [".toml"]).map((f) => `platforms/${f.split(/[\\/]/).pop()}`),
      ...listFiles(ws.projects(), [".toml"]).map((f) => `projects/${f.split(/[\\/]/).pop()}`),
      ...listFiles(ws.workflows(), [".yaml", ".yml"]).map((f) => `workflows/${f.split(/[\\/]/).pop()}`),
    ]);
    app.post("/api/config/stage", async (req) => {
      const b = body<{ file?: string; content?: string }>(req);
      if (!b.file || typeof b.content !== "string") bad("file and content are required");
      return stage(b.file, b.content, (f) => validateConfigFile(b.file!, f, rt));
    });
    app.post("/api/config/apply", async (req) => {
      const b = body<{ file?: string }>(req);
      if (!b.file) bad("file is required");
      const r = await apply(b.file, async () => healthAfterChange(rt));
      audit("user", r.applied ? "config.apply" : "config.rollback", { file: b.file, error: r.error });
      return r;
    });
    app.get("/api/config/history", async () => history());
    app.post("/api/config/restore", async (req) => {
      const b = body<{ stamp?: string; file?: string }>(req);
      if (!b.stamp || !b.file) bad("stamp and file are required");
      restore(b.stamp, b.file);
      rt.reload();
      audit("user", "config.restore", { file: b.file, stamp: b.stamp });
      return { ok: true };
    });

    app.get("/api/workflows", async () => {
      const platforms = loadPlatforms();
      return loadWorkflows().map((w) => ({ ...w, errors: validateWorkflow(w, platforms, rt.config.aliases) }));
    });
    app.post("/api/workflows/:name/run", async (req) => {
      const b = body<{ project?: string; inputs?: Record<string, string> }>(req);
      if (!b.project) bad("project is required");
      findProject(b.project);
      return engine.start((req.params as { name: string }).name, b.project, b.inputs ?? {});
    });
    app.get("/api/runs", async () => engine.list());
    app.get("/api/runs/:id", async (req) => {
      const r = engine.get((req.params as { id: string }).id);
      if (!r) throw new HttpError(404, "no such run");
      return r;
    });
    app.post("/api/runs/:id/approve", async (req) => engine.approve((req.params as { id: string }).id, body<{ content?: string }>(req).content));
    app.post("/api/runs/:id/reject", async (req) => engine.reject((req.params as { id: string }).id));
    app.post("/api/runs/:id/cancel", async (req) => engine.cancel((req.params as { id: string }).id));

    app.get("/api/audit", async (req) => readAudit(Math.min(1000, Number((req.query as { limit?: string }).limit ?? 200))));
    app.get("/api/audit/verify", async () => ({ first_broken: verifyAudit() }));

    /** The dashboard reaches other platforms through here, so their tokens stay on the server. */
    app.all("/api/peer/:platform/*", async (req) => {
      const { platform } = req.params as { platform: string; "*": string };
      const rest = (req.params as Record<string, string>)["*"] ?? "";
      if (!/^(status|models(\/swap)?|jobs(\/[A-Za-z0-9_-]+(\/(start|cancel))?)?|queue|projects|docs|results\/[a-z0-9_-]+)$/.test(rest)) {
        throw new HttpError(403, `peer path "${rest}" is not allowed`);
      }
      const p = loadPlatforms().find((x) => x.name === platform);
      if (!p) throw new HttpError(404, "no such platform");
      return new PeerClient(p).call(req.method, `/api/${rest}`, req.method === "GET" ? undefined : (req.body ?? {}), 30_000);
    });
  }

  // ===================================================================== dashboard
  const dist = resolve(repoRoot(), "dashboard", "dist");
  if (existsSync(join(dist, "index.html"))) {
    // wildcard: files are looked up per request, so a rebuilt dashboard is served without a restart.
    await app.register(fastifyStatic, { root: dist, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/assets/")) return reply.status(404).send({ error: "not found" });
      return reply.type("text/html").send(readFileSync(join(dist, "index.html")));
    });
  }

  return { app, rt, engine };
}

function planName(req: FastifyRequest): string {
  const n = (req.params as { name: string }).name;
  if (!/^[A-Za-z0-9._-]+\.md$/.test(n)) bad("bad plan name");
  return n;
}

function summarizeJob(j: Job) {
  const { log, output, ...rest } = j;
  const conf = (output?.confidence ?? (output?.best as { confidence?: unknown })?.confidence) as { status?: string } | undefined;
  return { ...rest, log_lines: log.length, confidence: conf?.status ?? null };
}

function latestResults() {
  const out: Record<string, unknown>[] = [];
  for (const p of loadProjects()) {
    const files = listFiles(join(ws.results(), p.name), [".json"]);
    const f = files[files.length - 1];
    if (f) {
      const { results: _r, ...s } = JSON.parse(readText(f)) as Record<string, unknown>;
      out.push(s);
    }
  }
  return out;
}

function validateConfigFile(rel: string, file: string, rt: Runtime): void {
  if (rel === "config.toml") loadFile(WorkspaceConfig, file);
  else if (rel === "links.toml") {
    const l = loadFile(LinksFile, file);
    const names = new Set(loadPlatforms().map((p) => p.name));
    for (const link of l.links) {
      if (!names.has(link.from) || !names.has(link.to)) throw new Error(`link ${link.from}→${link.to} names an unknown platform`);
    }
  } else if (rel.startsWith("platforms/")) {
    const p = loadFile(Platform, file);
    if (p.auto_run && p.sandbox.driver === "none") throw new Error("auto_run needs a sandbox driver");
  } else if (rel.startsWith("projects/")) loadFile(Project, file);
  else if (rel.startsWith("workflows/")) {
    const w = loadFile(WorkflowDef, file);
    const errs = validateWorkflow(w, loadPlatforms(), rt.config.aliases);
    if (errs.length) throw new Error(errs.join("; "));
  }
}

/** After a config change everything must still load, or the change is rolled back. */
async function healthAfterChange(rt: Runtime): Promise<boolean> {
  loadConfig();
  const platforms = loadPlatforms();
  loadLinks();
  loadProjects();
  for (const w of loadWorkflows()) {
    const errs = validateWorkflow(w, platforms, loadConfig().aliases);
    if (errs.length) throw new Error(`workflow ${w.name}: ${errs.join("; ")}`);
  }
  rt.reload();
  return true;
}

function sse(reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
}

function send(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
