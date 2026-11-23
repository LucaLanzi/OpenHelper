import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { runChecks } from "./checks/runner.js";
import { loadConfig, loadLanguages, loadPlatforms, loadProjects } from "./core/load.js";
import type { CheckKind } from "./core/schemas.js";
import { tail } from "./core/util.js";
import { openIndex } from "./index/build.js";
import { makeSandbox } from "./sandbox/sandbox.js";

/**
 * A small MCP server over stdio, so editor agents (Cline, Continue) can use OpenHelper's
 * search over your repos and pinned docs, and its language-pack checks, as tools.
 * Started by the editor with `node server/dist/cli.js mcp`. JSON-RPC 2.0, one message per line.
 */

const PROTOCOL = "2025-06-18";

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
}

const KINDS: CheckKind[] = ["syntax", "build", "test", "lint", "static"];

export const TOOLS: Tool[] = [
  {
    name: "list_projects",
    description: "List the OpenHelper projects on this machine: their repos, languages, doc packs and whether they are indexed.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const ps = loadProjects();
      if (!ps.length) return "No projects yet. Add one with `make add-project REPO=path`.";
      return ps
        .map((p) => {
          const idx = openIndex(p.name);
          return `${p.name}: repos ${p.repos.join(", ")}; languages ${p.languages.join(", ") || "?"}; docs ${p.docs.join(", ") || "none"}; ${idx ? `${idx.meta.chunks} passages indexed` : "not indexed"}`;
        })
        .join("\n");
    },
  },
  {
    name: "search",
    description:
      "Search a project's code and its version-pinned docs (cppreference, Python, CMake, Node.js, ...). Use it to confirm that an API, flag or file exists before using it. Returns labelled passages with file and line numbers; cite them.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name from list_projects" },
        query: { type: "string", description: "What to look for: an identifier, an error message or a question" },
        scope: { type: "string", enum: ["all", "code", "docs"], description: "Only your code, only docs, or both (default)" },
        k: { type: "integer", minimum: 1, maximum: 20, description: "How many passages (default 6)" },
      },
      required: ["project", "query"],
      additionalProperties: false,
    },
    run: async (a) => {
      const project = String(a.project ?? "");
      const idx = openIndex(project);
      if (!idx) return `Project "${project}" is not indexed. Run \`make index PROJECT=${project}\`.`;
      const scope = String(a.scope ?? "all");
      const k = Math.min(20, Math.max(1, Number(a.k ?? 6)));
      const hits = idx.search(String(a.query ?? ""), k, undefined, (c) =>
        scope === "code" ? c.source.startsWith("repo:") : scope === "docs" ? c.source.startsWith("doc:") : true,
      );
      if (!hits.length) return "No matching passages. Treat anything you can't find as unverified.";
      return hits
        .map((h, i) => `[S${i + 1}] ${h.source} ${h.path}:${h.start_line}-${h.end_line}\n${h.text.slice(0, 2500)}`)
        .join("\n\n");
    },
  },
  {
    name: "run_checks",
    description:
      "Build, test and lint a directory with OpenHelper's language packs (C++, CMake, Make, Python, Bash, JS/TS) inside the sandbox, network off. Returns Checked / Partly checked / Failed checks and the failing output. Run it after editing, before saying a change works.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to check (absolute, or relative to where the editor started this server)" },
        kinds: { type: "array", items: { type: "string", enum: KINDS }, description: "Only these kinds of checks (default: all)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    run: async (a) => {
      const cfg = loadConfig();
      const platform = loadPlatforms().find((p) => p.name === cfg.self);
      if (!platform) return `No platform file for "${cfg.self}".`;
      if (platform.sandbox.driver === "none" && process.env.OPENHELPER_MCP_ALLOW_HOST !== "1") {
        return "Refused: checks run the project's code, and this machine has no sandbox. Run `make sandbox-vm`, or set OPENHELPER_MCP_ALLOW_HOST=1 in the editor's MCP settings to allow running checks directly on this machine.";
      }
      const dir = resolve(String(a.path ?? "."));
      const kinds = Array.isArray(a.kinds) ? (a.kinds as string[]).filter((k): k is CheckKind => KINDS.includes(k as CheckKind)) : undefined;
      const r = await runChecks(dir, loadLanguages(), makeSandbox(platform.sandbox), { ...(kinds?.length ? { kinds } : {}) });
      const word = { green: "Checked", amber: "Partly checked", red: "Failed checks" }[r.confidence.status];
      const lines = [`${word}: ${r.confidence.reasons.join("; ")}`, `Languages: ${r.languages.join(", ") || "none detected"}`, ""];
      for (const x of r.results) lines.push(`${x.status.padEnd(7)} ${x.language}/${x.id}${x.reason ? ` (${x.reason})` : ""}`);
      for (const x of r.results.filter((y) => y.status === "fail" || y.status === "error")) {
        lines.push("", `--- ${x.language}/${x.id} output`, tail(x.output, 3000));
      }
      return lines.join("\n");
    },
  },
];

type Msg = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };

export async function handle(msg: Msg, version: string): Promise<Record<string, unknown> | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  if (msg.id === undefined) return undefined; // notifications need no answer
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "openhelper", version },
        instructions:
          "OpenHelper searches the user's own repos and version-pinned docs, and runs their build, tests and linters in a sandbox. Search before using an API you are unsure of, cite passages like [S1], and run_checks before claiming a change works.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ run: _r, ...t }) => t) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return error(-32602, `unknown tool ${name}`);
      try {
        const text = await tool.run((msg.params?.arguments as Record<string, unknown>) ?? {});
        return reply({ content: [{ type: "text", text }], isError: false });
      } catch (e) {
        return reply({ content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      return error(-32601, `method not found: ${msg.method}`);
  }
}

export function serveStdio(version: string): void {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: Msg;
    try {
      msg = JSON.parse(line) as Msg;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
      return;
    }
    void handle(msg, version).then((r) => {
      if (r) process.stdout.write(`${JSON.stringify(r)}\n`);
    });
  });
}
