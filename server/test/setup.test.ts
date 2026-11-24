import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../src/app.js";
import { toToml } from "../src/core/fsutil.js";
import { findModel, findProject } from "../src/core/load.js";
import { ensureApiToken } from "../src/core/secrets.js";
import { buildIndex } from "../src/index/build.js";
import type { Job } from "../src/jobs/queue.js";
import type { LlmClient } from "../src/llm/client.js";
import { newLoginCode, STARTER_MODELS } from "../src/setup.js";
import { modelFile } from "../src/swapconfig.js";
import { REPO_ROOT, samplePythonRepo, tempWorkspace, write } from "./helpers.js";
import { startMockLlm, type MockLlm } from "./mock-llm.js";

let a: App;
let mock: MockLlm;
let wsDir: string;
let token: string;

const auth = () => ({ authorization: `Bearer ${token}` });
const post = (url: string, payload: object = {}, remoteAddress = "127.0.0.1", headers: Record<string, string> = auth()) => a.app.inject({ method: "POST", url, headers, payload, remoteAddress });
const getJson = async <T>(url: string) => (await a.app.inject({ url, headers: auth() })).json() as T;

beforeAll(async () => {
  mock = await startMockLlm();
  wsDir = tempWorkspace();
  cpSync(join(REPO_ROOT, "workspace.example"), wsDir, { recursive: true });
  writeFileSync(join(wsDir, "config.toml"), readFileSync(join(wsDir, "config.toml"), "utf8").replace(/llm_url = .*/, `llm_url = "${mock.url}"`));
  token = ensureApiToken();
  a = await buildApp();
});

afterAll(async () => {
  await a?.app.close();
  await mock?.close();
});

describe("one-time sign-in link", () => {
  const login = (code: string, remote = "127.0.0.1") => post("/api/login", { code }, remote, {});

  it("signs in once, then stops working", async () => {
    const code = newLoginCode();
    const r = await login(code);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ token });
    expect((await login(code)).statusCode).toBe(401);
  });

  it("refuses a wrong code and burns the real one", async () => {
    const code = newLoginCode();
    expect((await login("wrong")).statusCode).toBe(401);
    expect((await login(code)).statusCode).toBe(401);
  });

  it("refuses an expired code and other devices", async () => {
    expect((await login(newLoginCode(-1))).statusCode).toBe(401);
    expect((await login(newLoginCode(), "100.64.0.9")).statusCode).toBe(403);
  });
});

describe("setup page", () => {
  it("downloads the starter models, checks their hashes and starts using them", async () => {
    expect(await getJson("/api/setup")).toMatchObject({ model_ready: false, sandbox_ready: false, done: false });
    // Local files stand in for the real downloads.
    for (const id of STARTER_MODELS) {
      const bytes = `fake gguf ${id}`;
      const src = write(wsDir, `downloads/${id}.gguf`, bytes);
      const m = findModel(id);
      write(wsDir, `packs/models/${id}.toml`, toToml({ ...m, sha256: createHash("sha256").update(bytes).digest("hex"), source: { ...m.source, url: `file://${src}` } } as unknown as Record<string, unknown>));
    }
    const j = (await post("/api/setup/model")).json() as Job;
    let done = j;
    for (let i = 0; i < 200 && !["done", "failed"].includes(done.status); i++) {
      await new Promise((r) => setTimeout(r, 50));
      done = await getJson<Job>(`/api/jobs/${j.id}`);
    }
    expect(done.error).toBeUndefined();
    expect(done.status).toBe("done");
    for (const id of STARTER_MODELS) expect(existsSync(modelFile(findModel(id)))).toBe(true);
    const platform = readFileSync(join(wsDir, "platforms", "desktop.toml"), "utf8");
    expect(platform).toMatch(/^current = "qwen3-8b-q4km"$/m);
    expect(platform).toMatch(/^embed = "qwen3-embedding-0.6b-q8"$/m);
    expect(readFileSync(join(wsDir, "llama-swap.yaml"), "utf8")).toContain("Qwen3-8B-Q4_K_M.gguf");
    expect(await getJson("/api/setup")).toMatchObject({ model_ready: true });
  }, 20_000);

  it("stops on a hash mismatch and keeps the model out of use", async () => {
    const id = STARTER_MODELS[0];
    const m = findModel(id);
    rmSync(modelFile(m));
    write(wsDir, `packs/models/${id}.toml`, toToml({ ...m, sha256: "0".repeat(64) } as unknown as Record<string, unknown>));
    const j = (await post("/api/setup/model")).json() as Job;
    let done = j;
    for (let i = 0; i < 200 && !["done", "failed"].includes(done.status); i++) {
      await new Promise((r) => setTimeout(r, 50));
      done = await getJson<Job>(`/api/jobs/${j.id}`);
    }
    expect(done.status).toBe("failed");
    expect(done.log.join("\n")).toContain("SHA-256 mismatch");
    expect(existsSync(modelFile(m))).toBe(false);
    expect(await getJson("/api/setup")).toMatchObject({ model_ready: false });
  }, 20_000);

  it("isn't finished until a repo has a search index", async () => {
    const repo = samplePythonRepo();
    write(wsDir, "projects/demo.toml", `name = "demo"\nrepos = ["${repo}"]\nlanguages = ["python"]\ndocs = []\n`);
    expect(await getJson("/api/setup")).toMatchObject({ projects: 1, indexed: 0, done: false });
    const lines: string[] = [];
    const llm = { embed: async () => Promise.reject(new Error("embeddings returned 500")) } as unknown as LlmClient;
    const meta = await buildIndex(findProject("demo"), { llm, embedModel: "e", log: (s) => lines.push(s) });
    expect(meta).toMatchObject({ dims: 0, embed_model: "" });
    expect(meta.chunks).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("keyword-only");
    expect(await getJson("/api/setup")).toMatchObject({ indexed: 1 });
  });

  it("can only be started from this machine, and not as a generic job", async () => {
    for (const url of ["/api/setup/model", "/api/setup/sandbox"]) expect((await post(url, {}, "100.64.0.9")).statusCode).toBe(403);
    for (const type of ["setup-model", "setup-sandbox"]) expect((await post("/api/jobs", { type, project: "x" })).statusCode).toBe(400);
  });
});
