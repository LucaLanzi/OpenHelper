import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { LlmClient } from "../src/llm/client.js";
import { audit, readAudit, verifyAudit } from "../src/core/audit.js";
import { assess, countValidCitations, type CheckResult } from "../src/core/confidence.js";
import { applyEditBlocks, parseEditBlocks } from "../src/core/editblocks.js";
import { canSend, matrix, withinBudget } from "../src/core/links.js";
import { loadDocPacks, loadLanguages, loadModels, loadWorkflows } from "../src/core/load.js";
import type { DocPack, HardwareInfo, ModelPack, Platform } from "../src/core/schemas.js";
import { DocPack as DocPackSchema, Platform as PlatformSchema, Project as ProjectSchema, SandboxConfig, WorkspaceConfig } from "../src/core/schemas.js";
import { scrub, isSecretFile } from "../src/core/scrub.js";
import { apply, stage } from "../src/core/staging.js";
import { candidates, makePlan, tierFor, usableMemoryGb } from "../src/core/tiers.js";
import { globToRegExp, parseDuration, render } from "../src/core/util.js";
import { validateWorkflow } from "../src/core/workflow-def.js";
import { addLocalDocs, DOC_FETCH_USER_AGENT, docStatus, fetchDocPack, infoToText } from "../src/index/docs.js";
import { implement, review } from "../src/agent/agents.js";
import { filesFromPlan, retrieve, retrieveAt, type AgentContext } from "../src/agent/context.js";
import { buildIndex } from "../src/index/build.js";
import { JobQueue } from "../src/jobs/queue.js";
import { runChecks } from "../src/checks/runner.js";
import { makeSandbox, type Sandbox } from "../src/sandbox/sandbox.js";
import { git, REPO_ROOT, samplePythonRepo, tempWorkspace, write } from "./helpers.js";

const desktop: HardwareInfo = {
  os: "linux",
  arch: "x64",
  cpu: "test",
  cores: 16,
  ram_gb: 32,
  gpu: { vendor: "nvidia", name: "RTX 2080 Ti", vram_gb: 11 },
  unified_memory: false,
  free_disk_gb: 400,
  detected_at: "now",
};
const mac: HardwareInfo = { ...desktop, os: "macos", arch: "arm64", gpu: { vendor: "apple", name: "M1 Pro", vram_gb: 0 }, unified_memory: true };

function model(p: Partial<ModelPack> & { id: string }): ModelPack {
  return {
    name: p.id,
    family: "f",
    kind: "dense",
    params_b: 8,
    active_params_b: 8,
    quant: "Q4_K_M",
    size_gb: 5,
    roles: ["main"],
    license: "apache-2.0",
    min_usable_gb: 1,
    ctx_default: 16384,
    tokenizer: "",
    source: { hf_repo: "", filename: "", url: "" },
    sha256: "",
    verified: false,
    server_args: [],
    notes: "",
    ...p,
  };
}

describe("tiers", () => {
  it("computes usable memory for the reference machines", () => {
    expect(usableMemoryGb(desktop)).toBe(35);
    expect(usableMemoryGb(mac)).toBe(24);
    expect(tierFor(35)).toBe("M");
    expect(tierFor(10)).toBe("XS");
    expect(tierFor(100)).toBe("XL");
  });

  it("prefers MoE over a dense model that would not fit in VRAM on a split machine", () => {
    const models = [
      model({ id: "dense27", params_b: 27, active_params_b: 27, size_gb: 17 }),
      model({ id: "moe35", kind: "moe", params_b: 35, active_params_b: 3, size_gb: 22 }),
      model({ id: "small", params_b: 8, size_gb: 5, roles: ["main", "light"] }),
    ];
    expect(candidates(desktop, models, "main")[0]!.id).toBe("moe35");
    const plan = makePlan(desktop, models);
    expect(plan.main?.id).toBe("moe35");
    expect(plan.light?.id).toBe("small");
    expect(plan.tier).toBe("M");
  });

  it("lets a tier override pick a smaller model", () => {
    const models = [
      model({ id: "moe35", kind: "moe", params_b: 35, active_params_b: 3, size_gb: 22 }),
      model({ id: "small", params_b: 8, size_gb: 5 }),
    ];
    expect(makePlan(desktop, models, "XS").main?.id).toBe("small");
  });

  it("warns when nothing fits", () => {
    const tiny: HardwareInfo = { ...desktop, ram_gb: 8, gpu: { vendor: "none", name: "", vram_gb: 0 } };
    const plan = makePlan(tiny, [model({ id: "big", size_gb: 22 })]);
    expect(plan.main).toBeUndefined();
    expect(plan.warnings.join(" ")).toMatch(/No main model/);
  });
});

describe("links", () => {
  const file = {
    kill_switch: false,
    links: [
      { from: "mac", to: "desktop", mode: "one-way" as const, budget: { max_hops: 2, max_tokens: 1000, max_wall_min: 1 } },
    ],
  };
  it("is isolated by default and respects direction", () => {
    expect(canSend({ kill_switch: false, links: [] }, "mac", "desktop").allowed).toBe(false);
    expect(canSend(file, "mac", "desktop").allowed).toBe(true);
    expect(canSend(file, "desktop", "mac").allowed).toBe(false);
    expect(canSend(file, "mac", "mac").allowed).toBe(true);
  });
  it("honours two-way links and the kill switch", () => {
    const two = { kill_switch: false, links: [{ ...file.links[0]!, mode: "two-way" as const }] };
    expect(canSend(two, "desktop", "mac").allowed).toBe(true);
    expect(canSend({ ...two, kill_switch: true }, "desktop", "mac").allowed).toBe(false);
    expect(matrix(two, ["mac", "desktop"]).every((m) => m.allowed)).toBe(true);
  });
  it("enforces budgets", () => {
    const l = file.links[0]!;
    expect(withinBudget(l, { hops: 3, tokens: 0, started_at: Date.now() }).allowed).toBe(false);
    expect(withinBudget(l, { hops: 1, tokens: 5000, started_at: Date.now() }).allowed).toBe(false);
    expect(withinBudget(l, { hops: 1, tokens: 10, started_at: Date.now() - 120_000 }).allowed).toBe(false);
    expect(withinBudget(l, { hops: 1, tokens: 10, started_at: Date.now() }).allowed).toBe(true);
  });
});

describe("confidence", () => {
  const r = (p: Partial<CheckResult>): CheckResult => ({
    id: "x",
    name: "x",
    language: "python",
    kind: "lint",
    required: true,
    status: "pass",
    output: "",
    duration_ms: 1,
    ...p,
  });
  it("is green only when required checks pass and tests ran", () => {
    expect(assess([r({ kind: "test" }), r({})]).status).toBe("green");
    expect(assess([r({})]).status).toBe("amber");
    expect(assess([r({ kind: "test" }), r({ status: "skipped" })]).status).toBe("amber");
    expect(assess([r({ kind: "test", status: "fail" })]).status).toBe("red");
    expect(assess([r({ kind: "test" })], { editErrors: 1 }).status).toBe("red");
  });
  it("counts only citations that point at supplied sources", () => {
    expect(countValidCitations("See [S1] and [S2], not [S9].", 2)).toEqual({ valid: 2, invalid: 1 });
    expect(assess([], { needsCitations: true, citations: 0 }).status).toBe("amber");
    expect(assess([], { needsCitations: true, citations: 2 }).status).toBe("green");
  });
});

describe("edit blocks", () => {
  it("parses and applies search/replace blocks, refusing ambiguous or unsafe ones", () => {
    const dir = tempWorkspace();
    write(dir, "a.py", "x = 1\ny = 2\nx = 1\n");
    write(dir, "b.py", "def f():\n    return 1\n");
    const text = [
      "Here is the change.",
      "",
      "b.py",
      "```python",
      "<<<<<<< SEARCH",
      "    return 1",
      "=======",
      "    return 2",
      ">>>>>>> REPLACE",
      "```",
      "a.py",
      "<<<<<<< SEARCH",
      "x = 1",
      "=======",
      "x = 3",
      ">>>>>>> REPLACE",
      "new/c.py",
      "<<<<<<< SEARCH",
      "=======",
      "print('hi')",
      ">>>>>>> REPLACE",
      "../escape.py",
      "<<<<<<< SEARCH",
      "=======",
      "bad",
      ">>>>>>> REPLACE",
    ].join("\n");
    const blocks = parseEditBlocks(text);
    expect(blocks.map((b) => b.path)).toEqual(["b.py", "a.py", "new/c.py", "../escape.py"]);
    const out = applyEditBlocks(dir, blocks);
    expect(out.map((o) => o.ok)).toEqual([true, false, true, false]);
    expect(out[1]!.error).toMatch(/2 places/);
    expect(readFileSync(join(dir, "b.py"), "utf8")).toContain("return 2");
    expect(readFileSync(join(dir, "new/c.py"), "utf8")).toBe("print('hi')\n");
  });
});

describe("scrub", () => {
  it("redacts common secrets and flags secret files", () => {
    const { text, redactions } = scrub(
      'aws = "AKIAABCDEFGHIJKLMNOP"\napi_key = "abcd1234efgh5678"\ntoken: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n',
    );
    expect(redactions).toBe(3);
    expect(text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(text).not.toContain("abcd1234efgh5678");
    expect(isSecretFile(".env")).toBe(true);
    expect(isSecretFile("config/.env.local")).toBe(true);
    expect(isSecretFile("keys/server.pem")).toBe(true);
    expect(isSecretFile("src/env.py")).toBe(false);
  });
});

describe("util", () => {
  it("parses durations, renders templates and matches globs", () => {
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(() => parseDuration("soon")).toThrow();
    expect(render("Do {task} with {missing}", { task: "x" })).toBe("Do x with {missing}");
    expect(globToRegExp("**/*.py").test("a/b/c.py")).toBe(true);
    expect(globToRegExp("**/*.py").test("c.py")).toBe(true);
    expect(globToRegExp("*.py").test("a/c.py")).toBe(false);
    expect(globToRegExp("**/test_*.{py,pyi}").test("tests/test_x.pyi")).toBe(true);
    expect(globToRegExp("**/CMakeLists.txt").test("CMakeLists.txt")).toBe(true);
  });
});

describe("engine packs", () => {
  it("all shipped packs validate", () => {
    tempWorkspace();
    expect(loadModels().length).toBeGreaterThan(0);
    const langs = loadLanguages().map((l) => l.id).sort();
    expect(langs).toEqual(expect.arrayContaining(["bash", "cmake", "cpp", "javascript", "make", "python"]));
    expect(loadDocPacks().length).toBeGreaterThan(0);
    expect(loadWorkflows().length).toBeGreaterThan(0);
  });

  it("shipped workflows validate against the example platforms", () => {
    tempWorkspace();
    const platforms: Platform[] = ["desktop", "mac"].map((name) =>
      PlatformSchema.parse({ name, url: `http://${name}.local:8740`, model: { current: "m" } }),
    );
    for (const w of loadWorkflows()) expect(validateWorkflow(w, platforms, { plan: "mac", build: "desktop" })).toEqual([]);
  });
});

describe("workflow validation", () => {
  it("catches unknown platforms, placeholders and duplicate ids", () => {
    const platforms = [PlatformSchema.parse({ name: "desktop", url: "http://x:1", model: { current: "m" } })];
    const errs = validateWorkflow(
      {
        name: "w",
        description: "",
        inputs: ["task"],
        steps: [
          { id: "a", platform: "desktop", agent: "planner", prompt: "{task}", gate: "none", checks: [], best_of: 1 },
          { id: "a", platform: "mac", agent: "planner", prompt: "{nope}", gate: "none", checks: [], best_of: 2 },
        ],
        limits: { max_hops: 6, max_wall: "1h", max_tokens: 1000 },
      },
      platforms,
    );
    expect(errs.join("\n")).toMatch(/defined twice/);
    expect(errs.join("\n")).toMatch(/unknown platform "mac"/);
    expect(errs.join("\n")).toMatch(/\{nope\}/);
    expect(errs.join("\n")).toMatch(/best_of/);
  });
});

describe("audit log", () => {
  beforeEach(() => tempWorkspace());
  it("chains entries and detects tampering", () => {
    audit("test", "one");
    audit("test", "two", { n: 2 });
    expect(readAudit().map((e) => e.action)).toEqual(["two", "one"]);
    expect(verifyAudit()).toBe(-1);
    const dir = process.env.OPENHELPER_WORKSPACE!;
    const f = join(dir, "audit", `${new Date().toISOString().slice(0, 10)}.jsonl`);
    writeFileSync(f, readFileSync(f, "utf8").replace('"two"', '"TWO"'));
    expect(verifyAudit()).toBe(1);
  });
});

describe("doc packs", () => {
  it("fall back to a mirror tarball when the main site cannot be reached, and index its Info manual", async () => {
    const dir = tempWorkspace();
    write(dir, "src/make-4.4.1/doc/make.info", "This is make.info.\n\x1f\nFile: make.info,  Node: Top\n\nGNU make\n********\n\nThe make utility...\n\x1f\nTag Table:\nNode: Top\x7f123\n\x1f\nEnd Tag Table\n");
    write(dir, "src/make-4.4.1/doc/make.texi", "@node Top");
    execFileSync("tar", ["-czf", join(dir, "make.tar.gz"), "-C", join(dir, "src"), "make-4.4.1"]);
    const tarball = readFileSync(join(dir, "make.tar.gz"));
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => res.writeHead(200).end(tarball));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      // Port 9 (discard) is closed on loopback, so the main source fails to connect.
      const pack = DocPackSchema.parse({
        id: "make-test",
        name: "make",
        version: "4.4.1",
        license: "GFDL",
        sources: [{ url: "http://127.0.0.1:9/make.html", format: "html", alternatives: [{ url: `http://127.0.0.1:${port}/make-4.4.1.tar.gz`, format: "tar", subdir: "doc" }] }],
      });
      const logs: string[] = [];
      expect(await fetchDocPack(pack, (l) => logs.push(l), 5000)).toBe(1);
      expect(logs.some((l) => l.startsWith("could not fetch http://127.0.0.1:9/make.html"))).toBe(true);
      const text = readFileSync(join(dir, "docs", "make-test", "text", "make.info.txt"), "utf8");
      expect(text).toContain("The make utility");
      expect(text).not.toContain("Tag Table");
      expect(text).not.toMatch(/[\x1f\x7f]/);
      expect(docStatus(pack).locked).toBe(true);
      // A wrong hash is a stop, never a reason to try the next source.
      const pinnedWrong = DocPackSchema.parse({ ...pack, sources: [{ url: `http://127.0.0.1:${port}/a.tar.gz`, format: "tar", sha256: "0".repeat(64), alternatives: [{ url: `http://127.0.0.1:${port}/b.tar.gz`, format: "tar" }] }] });
      await expect(fetchDocPack(pinnedWrong, () => {}, 5000)).rejects.toThrow(/SHA-256 mismatch/);
    } finally {
      server.close();
    }
  });
  it("lists the GNU mirrors as fallbacks", () => {
    for (const id of ["gnu-bash", "gnu-make"]) {
      const p = loadDocPacks().find((x) => x.id === id)!;
      expect(p.sources[0]!.url).toMatch(/^https:\/\/www\.gnu\.org\//);
      expect(p.sources[0]!.alternatives.map((a) => new URL(a.url).host)).toEqual(["ftpmirror.gnu.org", "mirrors.kernel.org"]);
    }
    expect(infoToText("a\x1f\nFile: x.info,  Node: Top\nb\x7f12")).toBe("a\n\nb");
  });
  it("say who is fetching, since gnu.org refuses Node's default User-Agent", async () => {
    tempWorkspace();
    const { createServer } = await import("node:http");
    let ua = "";
    const server = createServer((req, res) => {
      ua = req.headers["user-agent"] ?? "";
      if (!ua.startsWith("OpenHelper/")) return void res.writeHead(403).end();
      res.writeHead(200, { "content-type": "text/plain" }).end("Bash manual\n");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const pack = { id: "ua-test", sources: [{ url: `http://127.0.0.1:${port}/bash.txt`, format: "text", subdir: "" }] } as unknown as DocPack;
      expect(await fetchDocPack(pack)).toBe(1);
      expect(ua).toBe(DOC_FETCH_USER_AGENT);
    } finally {
      server.close();
    }
  });
});

describe("job queue", () => {
  it("writes a running job's log to its file before the job ends", async () => {
    const dir = tempWorkspace();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const q = new JobQueue(
      async (_job, log) => {
        log("task 1/5: started");
        await held;
        return {};
      },
      { logSaveMs: 0 },
    );
    const job = q.create({ type: "eval", project: "p", platform: "mac", model: "m", input: {} });
    q.start(job.id, "test");
    const file = join(dir, "jobs", `${job.id}.json`);
    for (let i = 0; i < 50 && !readFileSync(file, "utf8").includes("task 1/5"); i++) await new Promise((r) => setTimeout(r, 20));
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { status: string; log: string[] };
    expect(onDisk.status).toBe("running");
    expect(onDisk.log.at(-1)).toContain("task 1/5: started");
    release();
    await q.wait(job.id);
  });
});

describe("workspace config", () => {
  it("defaults to thinking only where it pays and caps answer length", () => {
    const c = WorkspaceConfig.parse({ self: "mac" });
    expect(c.max_tokens).toBe(8192);
    expect(c.reasoning).toEqual({ plan: true, implement: true, repair: false, review: false, explain: false });
    const d = WorkspaceConfig.parse({ self: "mac", max_tokens: 2048, reasoning: { implement: false } });
    expect(d.max_tokens).toBe(2048);
    expect(d.reasoning).toMatchObject({ plan: true, implement: false });
  });
});

describe("config staging", () => {
  it("applies with a backup and rolls back when health fails", async () => {
    const dir = tempWorkspace();
    write(dir, "links.toml", "kill_switch = false\n");
    const s = stage("links.toml", "kill_switch = true\n", () => {});
    expect(s.valid).toBe(true);
    expect(s.diff).toContain("+kill_switch = true");
    const bad = await apply("links.toml", async () => false);
    expect(bad.rolled_back).toBe(true);
    expect(readFileSync(join(dir, "links.toml"), "utf8")).toBe("kill_switch = false\n");
    stage("links.toml", "kill_switch = true\n", () => {});
    const good = await apply("links.toml", async () => true);
    expect(good.applied).toBe(true);
    expect(readFileSync(join(dir, "links.toml"), "utf8")).toBe("kill_switch = true\n");
    expect(existsSync(good.backup)).toBe(true);
  });
  it("refuses files outside the editable set and invalid content", () => {
    tempWorkspace();
    expect(() => stage("../etc/passwd", "x", () => {})).toThrow();
    expect(() => stage("secrets/tokens.toml", "x", () => {})).toThrow();
    const s = stage("links.toml", "not = [valid", () => {});
    expect(s.valid).toBe(false);
  });
});

describe("host sandbox", () => {
  it("puts the installer's check Python first on PATH", async () => {
    const root = tempWorkspace();
    const python = write(root, "vendor/check-python/bin/python3", "#!/bin/sh\n");
    chmodSync(python, 0o755);
    process.env.OPENHELPER_ROOT = root;
    try {
      const r = await makeSandbox(SandboxConfig.parse({})).run("command -v python3", root, { timeoutMs: 5000 });
      expect(r.output.trim()).toBe(python);
    } finally {
      process.env.OPENHELPER_ROOT = REPO_ROOT;
    }
  });
  it("runs Lima containers under the OpenHelper AppArmor profile with no network", async () => {
    const dir = tempWorkspace();
    // A VM with system containerd: plain `nerdctl` does not have the image, so the engine uses sudo.
    chmodSync(write(dir, "bin/limactl", '#!/bin/sh\n[ "$4" = nerdctl ] && [ "$5" = image ] && exit 1\nprintf "%s\\n" "$@"\n'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${join(dir, "bin")}:${path}`;
    try {
      const r = await makeSandbox(SandboxConfig.parse({ driver: "lima" })).run("true", dir, { timeoutMs: 5000 });
      const args = r.output.split("\n");
      expect(args[args.indexOf("--security-opt") + 1]).toBe("apparmor=openhelper-sandbox");
      expect(args[args.indexOf("--network") + 1]).toBe("none");
      expect(args.slice(args.indexOf("--") + 1, args.indexOf("--") + 3)).toEqual(["sudo", "nerdctl"]);
    } finally {
      process.env.PATH = path;
    }
  });
  it("reports a sandbox that cannot run instead of skipping every check", async () => {
    tempWorkspace();
    const sandbox: Sandbox = { driver: "lima", run: async () => ({ code: 1, output: "no such image", timed_out: false, duration_ms: 0 }) };
    await expect(runChecks(samplePythonRepo(), loadLanguages(), sandbox)).rejects.toThrow(/sandbox could not run/);
  });
  it("applies an edit with no path when the plan names one file", async () => {
    tempWorkspace();
    const repo = samplePythonRepo();
    const sandbox: Sandbox = {
      driver: "none",
      run: async (cmd) => ({ code: 0, output: cmd.startsWith("command -v") ? "python3\n" : "", timed_out: false, duration_ms: 0 }),
    };
    const reply = "<<<<<<< SEARCH\ndef add(a, b):\n=======\ndef add(a, b):  # edited\n>>>>>>> REPLACE\n";
    const out = await implement(implementCtx(repo, sandbox, () => reply), "Edit add\n\n## Files to change\n- `calc/ops.py`", { discardBranches: true });
    expect(out.best?.edit_errors).toEqual([]);
    expect(out.best?.files).toEqual(["calc/ops.py"]);
  });
});

describe("setup scripts", () => {
  it("finds the newest release tag in a repo with thousands of tags", () => {
    const repo = tempWorkspace();
    git(repo, "init", "-q");
    git(repo, "commit", "-q", "--allow-empty", "-m", "first");
    const sha = git(repo, "rev-parse", "HEAD");
    write(repo, ".git/packed-refs", Array.from({ length: 20_000 }, (_, i) => `${sha} refs/tags/b${i}\n`).join(""));
    const out = execFileSync("bash", ["-c", '. "$1/scripts/lib.sh"; newest_release_tag "$2"', "_", REPO_ROOT, repo], { encoding: "utf8" });
    expect(out.trim()).toBe("b19999");
  });
  it("make test does not reinstall dependencies that already exist", () => {
    const dir = tempWorkspace();
    for (const f of ["package.json", "server/package.json", "dashboard/package.json"]) write(dir, f, "{}");
    mkdirSync(join(dir, "node_modules"));
    utimesSync(join(dir, "node_modules"), new Date(0), new Date(0));
    writeFileSync(join(dir, "Makefile"), readFileSync(join(REPO_ROOT, "Makefile")));
    const out = execFileSync("make", ["-n", "test"], { cwd: dir, encoding: "utf8" });
    expect(out).toContain("npm test");
    expect(out).not.toContain("npm install");
  });
  it("make docs-add expands ~ and keeps a path with spaces together", () => {
    const dir = tempWorkspace();
    for (const f of ["package.json", "server/package.json", "dashboard/package.json"]) write(dir, f, "{}");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "Makefile"), readFileSync(join(REPO_ROOT, "Makefile")));
    const out = execFileSync("make", ["-n", "docs-add", "ID=cppreference", "FILE=~/My Docs/book.zip"], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: "/home/me" } });
    expect(out).toContain('docs add-local cppreference "/home/me/My Docs/book.zip"');
  });
  it("picks the nerdctl that has the sandbox image", () => {
    const dir = tempWorkspace();
    // Plain `nerdctl info` always works; the image exists under sudo only when SUDO_IMAGE=0.
    chmodSync(write(dir, "bin/limactl", '#!/bin/sh\nshift 3\ncase "$*" in\n"sudo nerdctl image inspect img") exit "$SUDO_IMAGE" ;;\n"nerdctl info") exit 0 ;;\nesac\nexit 1\n'), 0o755);
    const pick = (sudoImage: string) =>
      execFileSync("bash", ["-c", '. "$1/scripts/lib.sh"; PATH="$2:$PATH"; lima_nerdctl vm img', "_", REPO_ROOT, join(dir, "bin")], {
        encoding: "utf8",
        env: { ...process.env, SUDO_IMAGE: sudoImage },
      }).trim();
    expect(pick("0")).toBe("sudo nerdctl");
    expect(pick("1")).toBe("nerdctl");
  });
});

describe("doc packs", () => {
  it("counts a doc file larger than the source-file limit", () => {
    const dir = tempWorkspace();
    const file = write(dir, "big.md", "x".repeat(600 * 1024));
    expect(addLocalDocs("big", file)).toBe(1);
    expect(docStatus({ id: "big", sources: [] } as unknown as DocPack).fetched).toBe(true);
  });
  it("names the right make command for a pack that has not been added", async () => {
    tempWorkspace();
    const lines: string[] = [];
    await buildIndex(ProjectSchema.parse({ name: "calc", repos: [samplePythonRepo()], docs: ["cppreference", "python-stdlib"] }), { log: (s) => lines.push(s) });
    expect(lines.join("\n")).toContain("make docs-add ID=cppreference FILE=path");
    expect(lines.join("\n")).toContain("make docs-fetch ID=python-stdlib");
  });
});

describe("implement", () => {
  it("mounts the source repo read-only for first checks and repairs, so linked dependencies resolve", async () => {
    tempWorkspace();
    const repo = samplePythonRepo();
    const seen: (string[] | undefined)[] = [];
    const sandbox: Sandbox = {
      driver: "none",
      run: async (cmd, _cwd, o) => {
        if (cmd.startsWith("command -v")) return { code: 0, output: "python3\n", timed_out: false, duration_ms: 0 };
        seen.push(o.readOnly);
        return { code: 1, output: "failed", timed_out: false, duration_ms: 0 };
      },
    };
    const content = "calc/ops.py\n<<<<<<< SEARCH\ndef add(a, b):\n=======\ndef add(a, b):  # edited\n>>>>>>> REPLACE\n";
    const out = await implement(implementCtx(repo, sandbox, () => content), "Edit add\n\n## Files to change\n- `calc/ops.py`", { discardBranches: true });
    expect(out.best?.attempts).toBe(2);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((r) => r?.[0] === repo)).toBe(true);
  });
  it("shows the model a file whose edit failed, but never a path outside the worktree", async () => {
    const dir = tempWorkspace();
    write(dir, "worktrees/outside.txt", "TOP-SECRET");
    const repo = samplePythonRepo();
    const sandbox: Sandbox = {
      driver: "none",
      run: async (cmd) => ({ code: 0, output: cmd.startsWith("command -v") ? "python3\n" : "", timed_out: false, duration_ms: 0 }),
    };
    const bad = "calc/ops.py\n<<<<<<< SEARCH\nnot in the file\n=======\nx\n>>>>>>> REPLACE\n\n../outside.txt\n<<<<<<< SEARCH\nnope\n=======\nx\n>>>>>>> REPLACE\n";
    const prompts: string[] = [];
    const ctx = implementCtx(repo, sandbox, (m) => {
      prompts.push(m);
      return bad;
    });
    await implement(ctx, "Edit add\n\n## Files to change\n- `notes.txt`", { discardBranches: true });
    expect(prompts[1]).toContain("def add(a, b):");
    expect(prompts[1]).not.toContain("TOP-SECRET");
  });
});

describe("evals", () => {
  it("hides passages from commits newer than the task", async () => {
    const dir = tempWorkspace();
    const repo = samplePythonRepo();
    const project = ProjectSchema.parse({ name: "calc", repos: [repo] });
    await buildIndex(project);
    const old = join(dir, "old");
    git(repo, "worktree", "add", "-q", "--detach", old, "HEAD~2");
    const ctx = { config: { retrieval_top_k: 8 }, project, log: () => {} } as unknown as AgentContext;
    const hasAnswer = (ps: Awaited<ReturnType<typeof retrieve>>) => ps.some((p) => p.chunk.text.includes("def mul"));
    expect(hasAnswer(await retrieve(ctx, "mul function"))).toBe(true);
    expect(hasAnswer(await retrieveAt(ctx, "mul function", old))).toBe(false);
  });
  it("does not create a file named after a sentence", () => {
    const dir = tempWorkspace();
    const blocks = parseEditBlocks("No changes are needed.\n<<<<<<< SEARCH\n=======\nx\n>>>>>>> REPLACE\n");
    expect(applyEditBlocks(dir, blocks)[0]).toMatchObject({ ok: false, error: "not a file path" });
    expect(existsSync(join(dir, "No changes are needed."))).toBe(false);
  });
  it("reads a path written with a label or markdown", () => {
    for (const label of ["File path: calc/ops.py", "**File path:** `calc/ops.py`", "file: calc/ops.py", "`calc/ops.py`:"]) {
      expect(parseEditBlocks(`${label}\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n`)[0]?.path).toBe("calc/ops.py");
    }
  });
  it("gives a block with no path line the path of the block before it", () => {
    const blocks = parseEditBlocks("calc/ops.py\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>> REPLACE\n");
    expect(blocks.map((b) => b.path)).toEqual(["calc/ops.py", "calc/ops.py"]);
  });
  it("shows the plan's real path in the edit format, not a placeholder", async () => {
    tempWorkspace();
    const repo = samplePythonRepo();
    const sandbox: Sandbox = {
      driver: "none",
      run: async (cmd) => ({ code: 0, output: cmd.startsWith("command -v") ? "python3\n" : "", timed_out: false, duration_ms: 0 }),
    };
    const prompts: string[] = [];
    const reply = (p: string) => {
      prompts.push(p);
      return "calc/ops.py\n<<<<<<< SEARCH\ndef add(a, b):\n=======\ndef add(a, b):  # edited\n>>>>>>> REPLACE\n";
    };
    await implement(implementCtx(repo, sandbox, reply), "Edit add\n\n## Files to change\n- **calc/ops.py**: edit", { discardBranches: true });
    expect(prompts[0]).toContain("on its own line:\ncalc/ops.py\n<<<<<<< SEARCH");
    expect(prompts[0]).not.toContain("{example_path}");
  });
  it("finds files a plan writes in bold", () => {
    const repo = samplePythonRepo();
    const files = filesFromPlan("## Files to change\n- **calc/ops.py**: add it\n- **tests/test_ops.py**: test it\n\n## Steps\n1. Go", repo);
    expect(files.map((f) => f.path)).toEqual(["calc/ops.py", "tests/test_ops.py"]);
  });
});

describe("review", () => {
  const approves = () => implementCtx("/nowhere", { driver: "none", run: async () => ({ code: 0, output: "", timed_out: false, duration_ms: 0 }) }, () => "## Verdict\napprove, looks right.");
  it("does not let the model approve an empty patch", async () => {
    tempWorkspace();
    expect((await review(approves(), "plan", "", "python/pytest: pass")).verdict).toBe("changes needed");
  });
  it("does not let the model approve a change with failed checks", async () => {
    tempWorkspace();
    expect((await review(approves(), "plan", "+x", "Status: red (1 edit(s) could not be applied)\npython/pytest: pass")).verdict).toBe("changes needed");
    expect((await review(approves(), "plan", "+x", "Status: green (all checks passed)")).verdict).toBe("approve");
  });
});

function implementCtx(repo: string, sandbox: Sandbox, reply: (prompt: string) => string): AgentContext {
  return {
    config: WorkspaceConfig.parse({ self: "mac", retrieval_top_k: 0, repair_attempts: 1 }),
    project: { name: "calc", repos: [repo], languages: ["python"] },
    llm: {
      chat: async (o: { messages: { content: string }[] }) => ({ content: reply(o.messages.at(-1)!.content), prompt_tokens: 0, completion_tokens: 0, duration_ms: 0 }),
    },
    model: "m",
    sandbox,
    languages: loadLanguages(),
    log: () => {},
    signal: new AbortController().signal,
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  } as unknown as AgentContext;
}

describe("model client", () => {
  it("reads chat answers and usage from a stream, so long generations do not time out", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"<think>x</think>hel"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
        res.end('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const r = await new LlmClient(url).chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
      expect(r).toMatchObject({ content: "hello", prompt_tokens: 3, completion_tokens: 2 });
    } finally {
      server.close();
    }
  });
});
