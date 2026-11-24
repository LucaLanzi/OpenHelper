import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.js";

// Runs a snippet with scripts/lib.sh sourced and returns its trimmed stdout.
const lib = (snippet: string, env: Record<string, string> = {}) => {
  const r = spawnSync("bash", ["-c", `. "${join(REPO_ROOT, "scripts/lib.sh")}"; ${snippet}`], {
    encoding: "utf8",
    env: { ...process.env, JOBS: "", ...env },
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};

describe("llama.cpp build job count", () => {
  it("limits jobs by memory, keeping 4 GB free", () => {
    expect(lib("build_jobs_for 16 27 3")).toBe("7"); // 16 cores, 27 GB free, CUDA
    expect(lib("build_jobs_for 16 10 3")).toBe("2");
  });

  it("never exceeds the CPU count or drops below one", () => {
    expect(lib("build_jobs_for 8 64 1")).toBe("8");
    expect(lib("build_jobs_for 16 3 3")).toBe("1");
    expect(lib("build_jobs_for 4 0 3")).toBe("1");
  });

  it("uses JOBS when set, and a positive count on this machine otherwise", () => {
    expect(lib("build_jobs 3", { JOBS: "5" })).toBe("5");
    expect(Number(lib("build_jobs 3"))).toBeGreaterThanOrEqual(1);
  });
});
