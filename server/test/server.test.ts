import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app.js";
import { buildApp } from "../src/app.js";
import { ensureApiToken } from "../src/core/secrets.js";
import { buildIndex } from "../src/index/build.js";
import { findProject } from "../src/core/load.js";
import type { Job } from "../src/jobs/queue.js";
import { mineProject, saveTasks } from "../src/miner/mine.js";
import { loadLanguages } from "../src/core/load.js";
import type { WorkflowRun } from "../src/workflow/engine.js";
import { addLocalDocs } from "../src/index/docs.js";
import { REPO_ROOT, git, samplePythonRepo, tempWorkspace, write } from "./helpers.js";
import { startMockLlm, type MockLlm } from "./mock-llm.js";

let mock: MockLlm;
let a: App;
let token: string;
let repo: string;
let wsDir: string;

const auth = () => ({ authorization: `Bearer ${token}` });

async function api<T>(method: "GET" | "POST" | "PUT", url: string, payload?: unknown): Promise<T> {
  const r = await a.app.inject({ method, url, headers: auth(), ...(payload !== undefined ? { payload: payload as object } : {}) });
  if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return r.json() as T;
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out; last value: ${JSON.stringify(v).slice(0, 800)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  mock = await startMockLlm();
  wsDir = tempWorkspace();
  cpSync(join(REPO_ROOT, "workspace.example"), wsDir, { recursive: true });
  const cfg = readFileSync(join(wsDir, "config.toml"), "utf8").replace(/llm_url = .*/, `llm_url = "${mock.url}"`);
  writeFileSync(join(wsDir, "config.toml"), cfg);
  token = ensureApiToken();
  repo = samplePythonRepo();
  writeFileSync(join(wsDir, "projects", "calc.toml"), `name = "calc"\nrepos = ["${repo}"]\nlanguages = ["python"]\ndocs = []\n`);
  await buildIndex(findProject("calc"));
  a = await buildApp();
}, 60_000);

afterAll(async () => {
  await a?.app.close();
  await mock?.close();
});

describe("auth", () => {
  it("serves health without a token and refuses everything else", async () => {
    expect((await a.app.inject({ url: "/api/health" })).json()).toMatchObject({ ok: true, platform: "desktop" });
    expect((await a.app.inject({ url: "/api/status" })).statusCode).toBe(401);
    expect((await a.app.inject({ url: "/api/status", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await api<{ platform: string; llm_healthy: boolean }>("GET", "/api/status")).llm_healthy).toBe(true);
  });
});

describe("grounded chat", () => {
  it("streams an answer with citations and a confidence status", async () => {
    const r = await a.app.inject({ method: "POST", url: "/api/chat", headers: auth(), payload: { project: "calc", message: "where is add defined?" } });
    expect(r.headers["content-type"]).toContain("text/event-stream");
    expect(r.body).toContain("event: sources");
    expect(r.body).toContain("calc/ops.py");
    const done = /event: done\ndata: (.+)\n/.exec(r.body)?.[1];
    const d = JSON.parse(done!) as { confidence: { status: string }; citations: { valid: number } };
    expect(d.citations.valid).toBe(1);
    expect(d.confidence.status).toBe("green");
  });
});

describe("jobs", () => {
  it("does not run a job until someone starts it", async () => {
    const j = await api<Job>("POST", "/api/jobs", { type: "explain", project: "calc", input: { task: "what does add do?" } });
    await new Promise((r) => setTimeout(r, 200));
    expect((await api<Job>("GET", `/api/jobs/${j.id}`)).status).toBe("created");
    await api("POST", `/api/jobs/${j.id}/start`);
    const done = await until(() => api<Job>("GET", `/api/jobs/${j.id}`), (x) => x.status === "done");
    expect(String(done.output?.answer)).toContain("[S1]");
  });

  it("runs checks on the repo in a throwaway worktree", async () => {
    const j = await api<Job>("POST", "/api/jobs", { type: "check", project: "calc", input: {}, start: true });
    const done = await until(() => api<Job>("GET", `/api/jobs/${j.id}`), (x) => x.status === "done" || x.status === "failed");
    expect(done.status).toBe("done");
    const out = done.output as { results: { id: string; status: string }[]; confidence: { status: string } };
    expect(out.results.find((r) => r.id === "compile")?.status).toBe("pass");
    expect(out.results.find((r) => r.id === "pytest")?.status).toBe("pass");
    expect(git(repo, "branch", "--list", "openhelper/check-*")).toBe("");
  });

  it("repairs a failing first attempt", async () => {
    const j = await api<Job>("POST", "/api/jobs", { type: "implement", project: "calc", input: { plan: "## Goal\nAdd a div function\n\n## Files to change\n- `calc/ops.py`" }, start: true });
    const done = await until(() => api<Job>("GET", `/api/jobs/${j.id}`), (x) => x.status === "done" || x.status === "failed", 90_000);
    const best = (done.output as { best: { confidence: { status: string }; attempts: number; branch: string } }).best;
    expect(best.attempts).toBe(2);
    expect(best.confidence.status).not.toBe("red");
    expect(git(repo, "show", `${best.branch}:calc/ops.py`)).toContain("def div(a, b):");
    // Your checkout is never touched.
    expect(readFileSync(join(repo, "calc/ops.py"), "utf8")).not.toContain("div");
  }, 120_000);
});

describe("workflows", () => {
  it("plans, waits for approval, uses the edited plan, implements and reviews", async () => {
    const run = await api<WorkflowRun>("POST", "/api/workflows/implement-feature/run", { project: "calc", inputs: { task: "Add a subtraction helper" } });
    const gate1 = await until(() => api<WorkflowRun>("GET", `/api/runs/${run.id}`), (r) => r.status === "waiting-approval" || r.status === "failed");
    expect(gate1.status).toBe("waiting-approval");
    expect(gate1.gate?.content).toContain("## Steps");
    // The person edits the plan before approving; the coder must see the edit.
    await api("POST", `/api/runs/${run.id}/approve`, { content: `${gate1.gate!.content}\n\nNote from Luca: name it sub.` });
    const gate2 = await until(() => api<WorkflowRun>("GET", `/api/runs/${run.id}`), (r) => (r.status === "waiting-approval" && r.gate?.step === "review") || r.status === "failed", 120_000);
    expect(gate2.status).toBe("waiting-approval");
    expect(gate2.vars.plan).toContain("Note from Luca");
    expect(gate2.vars.patch).toContain("def sub(a, b):");
    // Build and test artefacts never end up in the patch (the sample repo has no .gitignore).
    expect(gate2.vars.patch).not.toContain("__pycache__");
    expect(gate2.vars.patch).not.toContain(".pyc");
    await api("POST", `/api/runs/${run.id}/approve`, {});
    const done = await until(() => api<WorkflowRun>("GET", `/api/runs/${run.id}`), (r) => r.status === "done" || r.status === "failed");
    expect(done.status).toBe("done");
    expect(done.steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
  }, 180_000);

  it("keeps a run waiting for approval across a restart, and finishes it after", async () => {
    const run = await api<WorkflowRun>("POST", "/api/workflows/implement-feature/run", { project: "calc", inputs: { task: "Add a subtraction helper" } });
    const gate = await until(() => api<WorkflowRun>("GET", `/api/runs/${run.id}`), (r) => r.status === "waiting-approval" || r.status === "failed");
    expect(gate.status).toBe("waiting-approval");
    // Restart the engine: a fresh app reads the runs back from the workspace.
    await a.app.close();
    a = await buildApp();
    const after = await api<WorkflowRun>("GET", `/api/runs/${run.id}`);
    expect(after).toMatchObject({ status: "waiting-approval", gate: { step: "plan" } });
    expect(after.steps.map((s) => s.status)).toEqual(["waiting-approval", "pending", "pending"]);
    await api("POST", `/api/runs/${run.id}/approve`, {});
    const review = await until(() => api<WorkflowRun>("GET", `/api/runs/${run.id}`), (r) => (r.status === "waiting-approval" && r.gate?.step === "review") || r.status === "failed", 120_000);
    expect(review.status).toBe("waiting-approval");
    expect(review.vars.patch).toContain("def sub(a, b):");
    expect(review.waited_ms).toBeGreaterThanOrEqual(0);
    await api("POST", `/api/runs/${run.id}/cancel`, {});
    expect((await api<WorkflowRun>("GET", `/api/runs/${run.id}`)).status).toBe("canceled");
  }, 180_000);

  it("refuses a cross-platform hand-off when the platforms are isolated", async () => {
    const cfg = readFileSync(join(wsDir, "config.toml"), "utf8").replace(/build = "desktop"/, 'build = "mac"');
    writeFileSync(join(wsDir, "config.toml"), cfg);
    a.rt.reload();
    const run = await api<WorkflowRun>("POST", "/api/workflows/implement-feature/run", { project: "calc", inputs: { task: "Add sub" } });
    const g = await until(() => api<WorkflowRun>("GET", `/api/runs/${run.id}`), (r) => r.status === "waiting-approval");
    await api("POST", `/api/runs/${g.id}/approve`, {});
    const r = await until(() => api<WorkflowRun>("GET", `/api/runs/${run.id}`), (x) => x.status === "refused" || x.status === "failed" || x.status === "done");
    expect(r.status).toBe("refused");
    expect(r.error).toMatch(/isolated by default/);
    writeFileSync(join(wsDir, "config.toml"), cfg.replace(/build = "mac"/, 'build = "desktop"'));
    a.rt.reload();
  }, 60_000);

  it("refuses inbox work from a platform without a link", async () => {
    const r = await a.app.inject({
      method: "POST",
      url: "/api/inbox/jobs",
      headers: auth(),
      payload: { envelope: { from: "mac", run_id: "r", step: "s", hops: 1, tokens: 0, started_at: new Date().toISOString() }, job: { type: "explain", project: "calc", input: { task: "x" } } },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe("config changes", () => {
  it("shows a diff, applies and rolls back", async () => {
    const before = await api<{ content: string }>("GET", "/api/config?file=links.toml");
    const staged = await api<{ diff: string; valid: boolean }>("POST", "/api/config/stage", { file: "links.toml", content: `${before.content}\n[[links]]\nfrom = "desktop"\nto = "nowhere"\nmode = "two-way"\n` });
    expect(staged.valid).toBe(false); // unknown platform
    const ok = await api<{ diff: string; valid: boolean }>("POST", "/api/config/stage", { file: "links.toml", content: `${before.content}\n[[links]]\nfrom = "desktop"\nto = "mac"\nmode = "one-way"\n` });
    expect(ok.valid).toBe(true);
    expect(ok.diff).toContain('+to = "mac"');
    const applied = await api<{ applied: boolean }>("POST", "/api/config/apply", { file: "links.toml" });
    expect(applied.applied).toBe(true);
    const links = await api<{ matrix: { from: string; to: string; allowed: boolean }[] }>("GET", "/api/links");
    expect(links.matrix.find((m) => m.from === "desktop" && m.to === "mac")?.allowed).toBe(true);
    expect(links.matrix.find((m) => m.from === "mac" && m.to === "desktop")?.allowed).toBe(false);
    await api("POST", "/api/kill-switch", { on: true });
    const killed = await api<{ matrix: { allowed: boolean }[] }>("GET", "/api/links");
    expect(killed.matrix.every((m) => !m.allowed)).toBe(true);
    await api("POST", "/api/kill-switch", { on: false });
  });
});

describe("models", () => {
  it("swaps models from the picker, between jobs", async () => {
    const m = await api<{ current: string; models: { id: string }[] }>("GET", "/api/models");
    expect(m.models.map((x) => x.id)).toContain("qwen3-8b-q4km");
    const r = await api<{ when: string }>("POST", "/api/models/swap", { model: "qwen3-8b-q4km" });
    expect(r.when).toBe("now");
    expect((await api<{ current: string }>("GET", "/api/models")).current).toBe("qwen3-8b-q4km");
    const bad = await a.app.inject({ method: "POST", url: "/api/models/swap", headers: auth(), payload: { model: "not-a-model" } });
    expect(bad.statusCode).toBe(500);
    await api("POST", "/api/models/swap", { model: "qwen3.6-35b-a3b-q4km" });
  });
});

describe("evals", () => {
  it("mines tasks from git history and scores a model with hidden tests", async () => {
    const tasks = mineProject(findProject("calc"), loadLanguages());
    expect(tasks.map((t) => t.message)).toEqual(["Add mul function for multiplying two numbers"]);
    expect(tasks[0]!.test_files).toEqual(["tests/test_ops.py"]);
    saveTasks("calc", tasks);
    const j = await api<Job>("POST", "/api/jobs", { type: "eval", project: "calc", input: {}, start: true });
    const done = await until(() => api<Job>("GET", `/api/jobs/${j.id}`), (x) => x.status === "done" || x.status === "failed", 120_000);
    expect(done.status).toBe("done");
    const s = done.output as { tasks: number; passed: number; errors_per_100: number };
    expect(s).toMatchObject({ tasks: 1, passed: 1, errors_per_100: 0 });
    // Evals leave no branches behind.
    expect(git(repo, "branch", "--list", "openhelper/add-mul*")).toBe("");
    expect(existsSync(join(wsDir, "results", "calc"))).toBe(true);
    // Plan and implement steps think; every call carries the configured token cap.
    const chats = mock.requests.filter((r) => r.path === "/v1/chat/completions");
    expect(chats.length).toBeGreaterThan(0);
    expect(chats.every((r) => r.max_tokens === 8192)).toBe(true);
  }, 180_000);

  it("does not score tasks the model server could not answer", async () => {
    mock.dropChats = true;
    try {
      const j = await api<Job>("POST", "/api/jobs", { type: "eval", project: "calc", input: {}, start: true });
      const done = await until(() => api<Job>("GET", `/api/jobs/${j.id}`), (x) => x.status === "done" || x.status === "failed", 120_000);
      expect(done.status).toBe("done");
      const s = done.output as { tasks: number; passed: number; errors_per_100: number | null; infra_errors: number };
      expect(s).toMatchObject({ tasks: 1, passed: 0, errors_per_100: null, hallucinations_per_100: null, infra_errors: 1 });
      expect(done.log.join("\n")).toContain("NOT SCORED");
      expect(git(repo, "branch", "--list", "openhelper/add-mul*")).toBe("");
    } finally {
      mock.dropChats = false;
    }
  }, 180_000);
});

describe("setup from the dashboard", () => {
  const post = (url: string, payload: object, remoteAddress = "127.0.0.1") => a.app.inject({ method: "POST", url, headers: auth(), payload, remoteAddress });

  it("adds a repo and builds its index in one step", async () => {
    addLocalDocs("python-stdlib", write(wsDir, "docsrc/lib.md", "# lib\n"));
    const r = await api<{ project: { languages: string[] }; job: Job }>("POST", "/api/projects", { path: samplePythonRepo(), name: "demo" });
    expect(r.project.languages).toContain("python");
    const done = await until(() => api<Job>("GET", `/api/jobs/${r.job.id}`), (x) => x.status === "done" || x.status === "failed");
    expect(done.status).toBe("done");
    const projects = await api<{ name: string; index: { chunks: number } | null }[]>("GET", "/api/projects");
    expect(projects.find((p) => p.name === "demo")?.index?.chunks).toBeGreaterThan(0);
  }, 60_000);

  it("explains a bad folder or name", async () => {
    expect((await post("/api/projects", { path: wsDir })).statusCode).toBe(400);
    expect((await post("/api/projects", { path: repo, name: "../evil" })).statusCode).toBe(400);
  });

  it("adds hand-downloaded docs", async () => {
    const file = write(wsDir, "docsrc/book/page.md", "# page\n");
    const j = (await post("/api/docs/cppreference/local", { path: file })).json() as Job;
    const done = await until(() => api<Job>("GET", `/api/jobs/${j.id}`), (x) => x.status === "done" || x.status === "failed");
    expect(done.output).toMatchObject({ files: 1 });
    expect((await post("/api/docs/cppreference/local", { path: join(wsDir, "missing") })).statusCode).toBe(400);
  });

  it("keeps local paths away from other devices and from generic jobs", async () => {
    for (const [url, payload] of [["/api/projects", { path: repo }], ["/api/docs/cppreference/local", { path: "/etc/hosts" }], ["/api/pick", { kind: "file" }]] as const) {
      expect((await post(url, payload, "100.64.0.9")).statusCode).toBe(403);
    }
    expect(((await a.app.inject({ url: "/api/host", headers: auth(), remoteAddress: "100.64.0.9" })).json() as { local: boolean }).local).toBe(false);
    for (const type of ["docs-local", "setup"]) {
      expect((await post("/api/jobs", { type, project: "calc", input: { pack: "cppreference", path: "/etc/hosts" } })).statusCode).toBe(400);
    }
  });

  it("counts this machine's own addresses as local, and lets other devices manage models", async () => {
    // With bind set to the Tailscale IP, a browser on this machine connects from that IP, not loopback.
    const own = Object.values(networkInterfaces()).flat().find((i) => i && !i.internal)?.address;
    if (own) expect(((await a.app.inject({ url: "/api/host", headers: auth(), remoteAddress: own })).json() as { local: boolean }).local).toBe(true);
    // Model routes take no local path; the token is enough. Bad input still fails, as a 400 rather than a 403.
    expect((await post("/api/models/qwen3-8b-q4km/use", { role: "nope" }, "100.64.0.9")).statusCode).toBe(400);
    expect((await post("/api/models/add", { url: "http://insecure" }, "100.64.0.9")).statusCode).toBe(400);
  });

  it("stops the VM once, after no dashboard and no job for unload_after_min, and refuses to turn off from elsewhere or mid-job", async () => {
    const rt = a.rt;
    const saved = rt.platform.sandbox.driver;
    rt.platform.sandbox.driver = "lima";
    const min = rt.platform.resources.unload_after_min * 60_000;
    try {
      const t0 = Date.now();
      rt.dashboards = 1;
      expect(rt.idleVmStop(t0)).toBe(false);
      expect(rt.idleVmStop(t0 + 2 * min)).toBe(false); // a dashboard is open
      rt.dashboards = 0;
      expect(rt.idleVmStop(t0 + 2 * min + 1)).toBe(false); // idle starts now
      expect(rt.idleVmStop(t0 + 3 * min)).toBe(true);
      expect(rt.idleVmStop(t0 + 4 * min)).toBe(false); // only once per idle spell
      rt.dashboards = 1;
      rt.idleVmStop(t0 + 4 * min);
      rt.dashboards = 0;
      rt.idleVmStop(t0 + 4 * min);
      expect(rt.idleVmStop(t0 + 5 * min)).toBe(true); // a new spell after the dashboard closed again
    } finally {
      rt.platform.sandbox.driver = saved;
    }
    expect((await post("/api/system/off", {}, "100.64.0.9")).statusCode).toBe(403);
    rt.queue.pause(true);
    const j = rt.queue.create({ type: "check", project: "calc", platform: rt.platform.name, model: "", input: {} });
    rt.queue.start(j.id);
    expect((await post("/api/system/off", {})).statusCode).toBe(409);
    rt.queue.cancel(j.id);
    rt.queue.pause(false);
  });

  it("reports the sandbox state", async () => {
    expect(await api("GET", "/api/sandbox")).toMatchObject({ driver: "none", state: "none" });
    expect((await post("/api/sandbox", { on: true })).statusCode).toBe(409);
  });
});

describe("audit", () => {
  it("recorded the activity and the chain is intact", async () => {
    const events = await api<{ action: string }[]>("GET", "/api/audit?limit=1000");
    const actions = new Set(events.map((e) => e.action));
    for (const x of ["job.create", "job.start", "workflow.approve", "link.refused", "inbox.refused", "config.apply", "kill-switch.on", "model.swap"]) {
      expect(actions).toContain(x);
    }
    expect((await api<{ first_broken: number }>("GET", "/api/audit/verify")).first_broken).toBe(-1);
  });
});
