/**
 * A deterministic stand-in for llama-swap, used by tests and for trying the dashboard
 * without a GPU: `npm run mock-llm` listens on 127.0.0.1:8741.
 * It recognises the prompt templates and answers like a well-behaved model would.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

interface Msg {
  role: string;
  content: string;
}

const PLAN = (task: string) => `## Goal
${task.trim().split("\n")[0]}

## Files to change
- \`calc/ops.py\`: add the new function next to \`add\` [S1].

## Steps
1. Add the function to calc/ops.py.
2. Run the tests.

## Commands allowed
- python3 -m pytest -q

## Risks and open questions
- none
`;

const BASE = "def add(a, b):\n    return a + b";

function edit(name: string, body: string) {
  return `calc/ops.py
<<<<<<< SEARCH
${BASE}
=======
${BASE}


def ${name}(a, b):
    ${body}
>>>>>>> REPLACE

Added ${name}.`;
}

export function reply(messages: Msg[]): string {
  const user = messages.filter((m) => m.role === "user").pop()?.content ?? "";
  if (user.includes("Write a plan for this task")) {
    const task = /Write a plan for this task:\n([\s\S]*?)\n\nUse only/.exec(user)?.[1] ?? "change";
    return PLAN(task);
  }
  if (user.includes("Your previous edits were applied, but checks failed")) {
    return `calc/ops.py
<<<<<<< SEARCH
def div(a, b)
    return a / b
=======
def div(a, b):
    return a / b
>>>>>>> REPLACE

Fixed the missing colon.`;
  }
  if (user.includes("Implement the approved plan")) {
    const plan = /Plan:\n([\s\S]*?)\n\nRelevant files/.exec(user)?.[1]?.toLowerCase() ?? "";
    if (plan.includes("mul")) return edit("mul", "return a * b");
    if (plan.includes("div")) {
      // First attempt has a syntax error, so the repair loop has something to do.
      return `calc/ops.py
<<<<<<< SEARCH
${BASE}
=======
${BASE}


def div(a, b)
    return a / b
>>>>>>> REPLACE`;
    }
    if (plan.includes("nothing")) return "I could not find what to change.";
    return edit("sub", "return a - b");
  }
  if (user.includes("Review this patch against the approved plan")) {
    return "## Verdict\napprove — the patch does what the plan says.\n\n## Problems\n- none\n\n## Plan coverage\nAll steps done.";
  }
  if (user.includes("Answer the question below")) {
    return "`add` is defined in calc/ops.py and returns the sum of its two arguments [S1].";
  }
  return "OK.";
}

function vector(text: string, dims = 16): number[] {
  const h = createHash("sha256").update(text.toLowerCase()).digest();
  return Array.from({ length: dims }, (_, i) => (h[i]! - 128) / 128);
}

export interface MockLlm {
  server: Server;
  url: string;
  requests: { path: string; model?: string }[];
  close: () => Promise<void>;
}

export function startMockLlm(port = 0): Promise<MockLlm> {
  const requests: { path: string; model?: string }[] = [];
  let loaded: string | undefined;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ path: req.url ?? "", ...(typeof body.model === "string" ? { model: body.model } : {}) });
      const json = (code: number, v: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(v));
      };
      if (req.url === "/health") return json(200, { status: "ok" });
      if (req.url === "/v1/models") return json(200, { data: [{ id: "mock" }] });
      if (req.url === "/running") return json(200, { running: loaded ? [{ model: loaded, state: "ready" }] : [] });
      if (req.url === "/api/models/unload") {
        loaded = undefined;
        return json(200, { ok: true });
      }
      if (req.url === "/v1/embeddings") {
        const input = Array.isArray(body.input) ? (body.input as string[]) : [String(body.input)];
        return json(200, { data: input.map((t, index) => ({ index, embedding: vector(t) })) });
      }
      if (req.url === "/v1/chat/completions") {
        loaded = String(body.model);
        const content = reply((body.messages as Msg[]) ?? []);
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const word of content.match(/\S+\s*/g) ?? []) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
          }
          res.end("data: [DONE]\n\n");
          return;
        }
        return json(200, {
          choices: [{ message: { role: "assistant", content } }],
          usage: { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: Math.ceil(content.length / 4) },
        });
      }
      json(404, { error: "not found" });
    });
  });
  return new Promise((resolveStart) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolveStart({
        server,
        url: `http://127.0.0.1:${p}`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8741);
  void startMockLlm(port).then((m) => process.stdout.write(`mock model server on ${m.url}\n`));
}
