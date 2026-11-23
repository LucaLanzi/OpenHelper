import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../src/app.js";
import { ensureApiToken } from "../src/core/secrets.js";
import type { WorkflowRun } from "../src/workflow/engine.js";
import { REPO_ROOT, samplePythonRepo, tempWorkspace } from "./helpers.js";
import { startMockLlm, type MockLlm } from "./mock-llm.js";

/**
 * Two real processes: this one is the desktop (agents + dashboard), a child process is the Mac
 * (agents only). A workflow plans on the Mac, implements on the desktop and reviews on the Mac.
 */

let mock: MockLlm;
let desktop: App;
let mac: ChildProcess;
let macPort = 0;
let desktopToken = "";
let deskWs = "";
const macToken = "mac-test-token-0123456789abcdef";

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

function setupWorkspace(dir: string, self: string, roles: string, repo: string, linksToml: string) {
  cpSync(join(REPO_ROOT, "workspace.example"), dir, { recursive: true });
  let cfg = readFileSync(join(dir, "config.toml"), "utf8")
    .replace(/^self = .*$/m, `self = "${self}"`)
    .replace(/^roles = .*$/m, `roles = ${roles}`)
    .replace(/^llm_url = .*$/m, `llm_url = "${mock.url}"`)
    .replace(/^port = .*$/m, `port = ${self === "mac" ? macPort : 8740}`);
  cfg = cfg.replace(/plan = "desktop"/, 'plan = "mac"');
  writeFileSync(join(dir, "config.toml"), cfg);
  const macToml = readFileSync(join(dir, "platforms", "mac.toml"), "utf8").replace(/^url = .*$/m, `url = "http://127.0.0.1:${macPort}"`);
  writeFileSync(join(dir, "platforms", "mac.toml"), macToml);
  writeFileSync(join(dir, "projects", "calc.toml"), `name = "calc"\nrepos = ["${repo}"]\nlanguages = ["python"]\ndocs = []\n`);
  writeFileSync(join(dir, "links.toml"), linksToml);
}

const TWO_WAY = 'kill_switch = false\n[[links]]\nfrom = "mac"\nto = "desktop"\nmode = "two-way"\n';

beforeAll(async () => {
  mock = await startMockLlm();
  macPort = await freePort();
  const repo = samplePythonRepo();

  const macWs = tempWorkspace();
  setupWorkspace(macWs, "mac", '["node"]', repo, TWO_WAY);
  mkdirSync(join(macWs, "secrets"), { recursive: true });

  deskWs = tempWorkspace();
  setupWorkspace(deskWs, "desktop", '["node", "control"]', repo, TWO_WAY);
  desktopToken = ensureApiToken();
  writeFileSync(join(deskWs, "secrets", "peers.toml"), `mac = "${macToken}"\n`);

  mac = spawn(process.execPath, ["--import", "tsx", join(REPO_ROOT, "server", "src", "cli.ts"), "serve"], {
    cwd: join(REPO_ROOT, "server"),
    env: { ...process.env, OPENHELPER_WORKSPACE: macWs, OPENHELPER_ROOT: REPO_ROOT, OPENHELPER_TOKEN: macToken },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let macLog = "";
  mac.stdout?.on("data", (d) => (macLog += d));
  mac.stderr?.on("data", (d) => (macLog += d));
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${macPort}/api/health`);
      if (r.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() - t0 > 30_000) throw new Error(`mac node did not start:\n${macLog}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  process.env.OPENHELPER_WORKSPACE = deskWs;
  desktop = await buildApp();
}, 60_000);

afterAll(async () => {
  mac?.kill("SIGTERM");
  await desktop?.app.close();
  await mock?.close();
});

async function api<T>(method: "GET" | "POST", url: string, payload?: unknown): Promise<T> {
  const r = await desktop.app.inject({ method, url, headers: { authorization: `Bearer ${desktopToken}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return r.json() as T;
}

async function waitRun(id: string, ok: (r: WorkflowRun) => boolean, ms = 90_000): Promise<WorkflowRun> {
  const t0 = Date.now();
  for (;;) {
    const r = await api<WorkflowRun>("GET", `/api/runs/${id}`);
    if (ok(r)) return r;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${JSON.stringify(r).slice(0, 1000)}`);
    await new Promise((res) => setTimeout(res, 200));
  }
}

describe("two platforms", () => {
  it("the dashboard sees both platforms", async () => {
    const ps = await api<{ name: string; reachable: boolean; status?: { platform: string } }[]>("GET", "/api/platforms");
    expect(ps.find((p) => p.name === "mac")).toMatchObject({ reachable: true, status: { platform: "mac" } });
    expect(ps.find((p) => p.name === "desktop")).toMatchObject({ reachable: true });
  });

  it("plans on the Mac, implements on the desktop, reviews on the Mac", async () => {
    const run = await api<WorkflowRun>("POST", "/api/workflows/implement-feature/run", { project: "calc", inputs: { task: "Add a subtraction helper" } });
    const g1 = await waitRun(run.id, (r) => r.status === "waiting-approval" || r.status === "failed" || r.status === "refused");
    expect(g1.status).toBe("waiting-approval");
    expect(g1.steps[0]).toMatchObject({ platform: "mac", status: "waiting-approval" });
    await api("POST", `/api/runs/${run.id}/approve`, {});
    const g2 = await waitRun(run.id, (r) => (r.status === "waiting-approval" && r.gate?.step === "review") || r.status === "failed" || r.status === "refused", 120_000);
    expect(g2.status).toBe("waiting-approval");
    expect(g2.steps[1]).toMatchObject({ platform: "desktop", status: "done" });
    expect(g2.vars.patch).toContain("def sub(a, b):");
    await api("POST", `/api/runs/${run.id}/approve`, {});
    const done = await waitRun(run.id, (r) => r.status === "done" || r.status === "failed");
    expect(done.status).toBe("done");
    expect(done.hops).toBe(2);
  }, 180_000);

  it("refuses the same run when the link is isolated", async () => {
    writeFileSync(join(deskWs, "links.toml"), "kill_switch = false\n");
    const run = await api<WorkflowRun>("POST", "/api/workflows/implement-feature/run", { project: "calc", inputs: { task: "Add a subtraction helper" } });
    const g1 = await waitRun(run.id, (r) => r.status === "waiting-approval" || r.status === "failed");
    expect(g1.status).toBe("waiting-approval");
    await api("POST", `/api/runs/${run.id}/approve`, {});
    const r = await waitRun(run.id, (x) => x.status === "refused" || x.status === "failed" || x.status === "done");
    expect(r.status).toBe("refused");
    expect(r.steps[1]).toMatchObject({ platform: "desktop", status: "refused" });
    const audit = await api<{ action: string }[]>("GET", "/api/audit?limit=500");
    expect(audit.some((e) => e.action === "link.refused")).toBe(true);
    writeFileSync(join(deskWs, "links.toml"), TWO_WAY);
  }, 120_000);

  it("the Mac's own link file is enforced too", async () => {
    // Even with a valid token, the Mac refuses work from the desktop unless its links allow it.
    const r = await fetch(`http://127.0.0.1:${macPort}/api/inbox/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${macToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        envelope: { from: "laptop-2", run_id: "x", step: "y", hops: 1, tokens: 0, started_at: new Date().toISOString() },
        job: { type: "explain", project: "calc", input: { task: "hi" } },
      }),
    });
    expect(r.status).toBe(403);
  });
});
