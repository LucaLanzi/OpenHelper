import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findProject } from "../src/core/load.js";
import { buildIndex } from "../src/index/build.js";
import { REPO_ROOT, samplePythonRepo, tempWorkspace } from "./helpers.js";

let child: ChildProcessWithoutNullStreams;
let repo = "";
let nextId = 1;
const pending = new Map<number, (v: Record<string, unknown>) => void>();

function call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((res) => pending.set(id, res));
}

async function tool(name: string, args: Record<string, unknown>): Promise<string> {
  const r = (await call("tools/call", { name, arguments: args })) as { result: { content: { text: string }[] } };
  return r.result.content[0]!.text;
}

beforeAll(async () => {
  const ws = tempWorkspace();
  cpSync(join(REPO_ROOT, "workspace.example"), ws, { recursive: true });
  repo = samplePythonRepo();
  writeFileSync(join(ws, "projects", "calc.toml"), `name = "calc"\nrepos = ["${repo}"]\nlanguages = ["python"]\ndocs = []\n`);
  await buildIndex(findProject("calc"));
  child = spawn(process.execPath, ["--import", "tsx", join(REPO_ROOT, "server", "src", "cli.ts"), "mcp"], {
    cwd: join(REPO_ROOT, "server"),
    env: { ...process.env, OPENHELPER_WORKSPACE: ws, OPENHELPER_ROOT: REPO_ROOT, OPENHELPER_MCP_ALLOW_HOST: "" },
  });
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line) as { id: number };
      pending.get(msg.id)?.(msg as unknown as Record<string, unknown>);
    }
  });
}, 60_000);

afterAll(() => child?.kill());

describe("MCP server for editor agents", () => {
  it("initializes and lists its tools", async () => {
    const init = (await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })) as {
      result: { serverInfo: { name: string }; capabilities: { tools: object } };
    };
    expect(init.result.serverInfo.name).toBe("openhelper");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const list = (await call("tools/list")) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["list_projects", "search", "run_checks"]);
  });

  it("searches the project and cites passages", async () => {
    expect(await tool("list_projects", {})).toMatch(/calc: .*indexed/);
    const text = await tool("search", { project: "calc", query: "mul function", scope: "code" });
    expect(text).toMatch(/^\[S1\] repo:/);
    expect(text).toMatch(/\[S\d\] repo:\S+ calc\/ops\.py:1-/);
  });

  it("refuses to run checks without a sandbox unless allowed", async () => {
    expect(await tool("run_checks", { path: repo })).toMatch(/^Refused/);
  });

  it("answers unknown methods with an error", async () => {
    const r = (await call("nope")) as { error: { code: number } };
    expect(r.error.code).toBe(-32601);
  });
});
