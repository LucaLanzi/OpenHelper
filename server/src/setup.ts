import { spawn } from "node:child_process";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ensureDir, readJson, writeFileAtomic } from "./core/fsutil.js";
import { repoRoot, ws } from "./core/paths.js";
import { newToken, safeEqual } from "./core/util.js";

/** What the setup page downloads: the main model, then the embedding model for search. */
export const STARTER_MODELS = ["qwen3-8b-q4km", "qwen3-embedding-0.6b-q8"] as const;

const codeFile = () => join(ws.secrets(), "login-code");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A single-use code for the link `make install` opens, so the first login needs no pasted token. */
export function newLoginCode(ttlMs = 5 * 60_000): string {
  const code = newToken();
  ensureDir(ws.secrets());
  writeFileAtomic(codeFile(), JSON.stringify({ sha256: sha(code), expires: Date.now() + ttlMs }));
  chmodSync(codeFile(), 0o600);
  return code;
}

/** Any attempt uses the code up, right or wrong. */
export function redeemLoginCode(code: string): boolean {
  if (!existsSync(codeFile())) return false;
  const saved = readJson<{ sha256?: string; expires?: number }>(codeFile(), {});
  rmSync(codeFile(), { force: true });
  return Boolean(saved.sha256) && Date.now() < (saved.expires ?? 0) && safeEqual(sha(code), saved.sha256!);
}

/** Runs one of the repo's setup scripts as a job, with its output in the job log. */
export function runScript(script: string, args: string[], env: Record<string, string>, log: (s: string) => void, signal: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(join(repoRoot(), "scripts", script), args, { cwd: repoRoot(), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let buf = "";
    let lastProgress = 0;
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      const lines = buf.split(/[\r\n]+/);
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        // eslint-disable-next-line no-control-regex
        const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (!line) continue;
        // curl redraws its progress many times a second.
        if (/^\d+\s+[\d.]+[kKMGT]?\s/.test(line)) {
          if (Date.now() - lastProgress < 3000) continue;
          lastProgress = Date.now();
        }
        log(line);
      }
    };
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        // already gone
      }
    };
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", fail);
    child.on("close", (code) => {
      signal.removeEventListener("abort", stop);
      if (code === 0) done();
      else fail(new Error(signal.aborted ? "canceled" : `${script} failed (exit ${code ?? "signal"}); see the log above`));
    });
  });
}
