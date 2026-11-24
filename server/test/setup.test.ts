import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../src/app.js";
import { readAudit } from "../src/core/audit.js";
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

describe("models page", () => {
  it("adds a model from a GGUF link and refuses a bad one", async () => {
    const add = (payload: object) => post("/api/models/add", payload);
    expect((await add({ url: "http://example.com/a.gguf", size_gb: 1 })).statusCode).toBe(400);
    expect((await add({ url: "https://example.com/a.bin", size_gb: 1 })).statusCode).toBe(400);
    expect((await add({ url: "https://example.com/a.gguf", size_gb: 0 })).statusCode).toBe(400);
    const r = await add({ url: "https://example.com/org/My-Model-Q4_K_M.gguf", size_gb: 2.5, role: "main", license: "MIT" });
    expect(r.json()).toEqual({ id: "my-model-q4-k-m" });
    expect((await add({ url: "https://example.com/org/My-Model-Q4_K_M.gguf", size_gb: 2.5 })).statusCode).toBe(400);
    const m = (await getJson<{ id: string; quant: string; present: boolean; has_source: boolean; license: string }[]>("/api/models/all")).find((x) => x.id === "my-model-q4-k-m");
    expect(m).toMatchObject({ quant: "Q4_K_M", present: false, has_source: true, license: "MIT" });
  });

  it("gives a job only to a downloaded model of the right kind", async () => {
    const use = (id: string, role: string) => post(`/api/models/${id}/use`, { role });
    expect((await use("my-model-q4-k-m", "main")).statusCode).toBe(400);
    const file = modelFile(findModel("my-model-q4-k-m"));
    write(dirname(file), basename(file), "stand-in");
    expect((await use("my-model-q4-k-m", "embed")).statusCode).toBe(400);
    expect((await use("my-model-q4-k-m", "nonsense")).statusCode).toBe(400);
    expect((await use("my-model-q4-k-m", "main")).statusCode).toBe(200);
    const m = (await getJson<{ id: string; uses: string[] }[]>("/api/models/all")).find((x) => x.id === "my-model-q4-k-m");
    expect(m?.uses).toContain("main");
    expect(readFileSync(join(wsDir, "platforms", "desktop.toml"), "utf8")).toMatch(/^current = "my-model-q4-k-m"$/m);
    expect(readFileSync(join(wsDir, "llama-swap.yaml"), "utf8")).toContain("My-Model-Q4_K_M.gguf");
  });

  it("refuses a download link that isn't https", async () => {
    expect((await post("/api/models/my-model-q4-k-m/download", { url: "file:///etc/hosts" })).statusCode).toBe(400);
  });
});

describe("languages", () => {
  it("adds a language and detects it in a project", async () => {
    const repo = samplePythonRepo();
    write(repo, "src/lib.rs", "pub fn one() -> i32 { 1 }\n");
    write(wsDir, "projects/rusty.toml", `name = "rusty"\nrepos = ["${repo}"]\nlanguages = ["python"]\ndocs = []\n`);
    expect((await post("/api/languages", { name: "Rust", extensions: "../x" })).statusCode).toBe(400);
    expect((await post("/api/languages", { name: "Rust", extensions: ".rs, rlib", test: "cargo test --offline" })).json()).toEqual({ id: "rust" });
    expect((await post("/api/languages", { name: "Rust", extensions: "rs" })).statusCode).toBe(400);
    expect((await getJson<{ id: string; checks: string[] }[]>("/api/languages")).find((l) => l.id === "rust")?.checks).toEqual(["cargo test --offline"]);
    const r = (await post("/api/projects/rusty/detect")).json() as { languages: string[] };
    expect(r.languages).toEqual(expect.arrayContaining(["python", "rust"]));
    expect(findProject("rusty").languages).toContain("rust");
    const remove = (id: string, payload: object = { confirm: true }) => a.app.inject({ method: "DELETE", url: `/api/languages/${id}`, headers: auth(), payload, remoteAddress: "127.0.0.1" });
    expect((await remove("rust")).statusCode).toBe(400); // rusty uses it
    expect((await remove("python")).statusCode).toBe(400); // built-in
    expect((await post("/api/languages", { name: "Wrong", extensions: "wr" })).statusCode).toBe(200);
    expect((await getJson<{ id: string; custom: boolean }[]>("/api/languages")).find((l) => l.id === "wrong")?.custom).toBe(true);
    expect((await remove("wrong", {})).statusCode).toBe(400);
    expect((await remove("wrong")).statusCode).toBe(200);
    expect((await getJson<{ id: string }[]>("/api/languages")).some((l) => l.id === "wrong")).toBe(false);
  });

  it("adds a documentation pack with or without a download link", async () => {
    expect((await post("/api/docs", { name: "Rust std", url: "http://x.org/a.tgz" })).statusCode).toBe(400);
    expect((await post("/api/docs", { name: "Rust std", version: "1.82", url: "https://x.org/a.tar.gz" })).json()).toEqual({ id: "rust-std" });
    expect((await post("/api/docs", { name: "Rust std" })).statusCode).toBe(400);
    expect((await post("/api/docs", { name: "My notes" })).json()).toEqual({ id: "my-notes" });
    const docs = await getJson<{ id: string; version: string; sources: unknown[] }[]>("/api/docs");
    expect(docs.find((d) => d.id === "rust-std")).toMatchObject({ version: "1.82", sources: [{ url: "https://x.org/a.tar.gz", format: "tar" }] });
    expect(docs.find((d) => d.id === "my-notes")?.sources).toEqual([]);
  });
});

describe("this machine only", () => {
  it("refuses every changing action from another device", async () => {
    const urls = ["/api/models/add", "/api/models/qwen3-8b-q4km/download", "/api/models/qwen3-8b-q4km/use", "/api/models/qwen3-8b-q4km/bench", "/api/models/qwen3-8b-q4km/tune", "/api/languages", "/api/docs", "/api/projects/demo/detect", "/api/system/restart", "/api/system/update"];
    for (const url of urls) expect((await post(url, {}, "100.64.0.9")).statusCode, url).toBe(403);
    for (const type of ["model-download", "bench", "tune"]) expect((await post("/api/jobs", { type, project: "demo" })).statusCode).toBe(400);
  });

  it("reports the install", async () => {
    expect(await getJson("/api/system")).toMatchObject({ version: "0.0.1" });
  });
});

describe("deleting a downloaded model", () => {
  const del = (url: string, payload: object = { confirm: true }, remoteAddress = "127.0.0.1") => a.app.inject({ method: "DELETE", url, headers: auth(), payload, remoteAddress });
  type Row = { id: string; present: boolean; uses: string[] };

  it("frees the file and any partial download, keeps the model listed, and audits it", async () => {
    const rows = await getJson<Row[]>("/api/models/all");
    const spare = rows.find((m) => !m.uses.length)!;
    const file = modelFile(findModel(spare.id));
    write(dirname(file), basename(file), "12345");
    write(dirname(file), `${basename(file)}.part`, "678");
    expect((await del(`/api/models/${spare.id}/file`, {})).statusCode).toBe(400);
    expect((await del(`/api/models/${spare.id}/file`, { confirm: true }, "100.64.0.9")).statusCode).toBe(403);
    const r = await del(`/api/models/${spare.id}/file`);
    expect(r.json()).toEqual({ ok: true, freed_bytes: 8 });
    expect(existsSync(file) || existsSync(`${file}.part`)).toBe(false);
    expect((await getJson<Row[]>("/api/models/all")).find((m) => m.id === spare.id)).toMatchObject({ present: false });
    expect(readAudit().some((e) => e.action === "model.delete_file")).toBe(true);
    expect((await del(`/api/models/${spare.id}/file`)).json().error).toContain("not downloaded");
  });

  it("refuses a model this machine uses", async () => {
    const main = (await getJson<Row[]>("/api/models/all")).find((m) => m.uses.includes("main"))!;
    const file = modelFile(findModel(main.id));
    if (!existsSync(file)) write(dirname(file), basename(file), "x");
    const r = await del(`/api/models/${main.id}/file`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain("Choose another model for that first");
    expect(existsSync(file)).toBe(true);
  });
});
