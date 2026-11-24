import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.js";

function cli(ws: string, ...args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "server", "src", "cli.ts"), ...args], {
    cwd: join(REPO_ROOT, "server"),
    env: { ...process.env, OPENHELPER_WORKSPACE: ws, OPENHELPER_ROOT: REPO_ROOT },
    encoding: "utf8",
  });
}

describe("openhelper init", () => {
  it("sets up one machine: its own platform file, aliases pointing at it, a token", () => {
    const ws = join(mkdtempSync(join(tmpdir(), "oh-init-")), "workspace");
    cli(ws, "init", "--platform", "laptop");
    expect(readdirSync(join(ws, "platforms"))).toEqual(["laptop.toml"]);
    const cfg = readFileSync(join(ws, "config.toml"), "utf8");
    expect(cfg).toMatch(/^self = "laptop"$/m);
    expect(cfg).toMatch(/^plan = "laptop"$/m);
    expect(cfg).toMatch(/^build = "laptop"$/m);
    const p = readFileSync(join(ws, "platforms", "laptop.toml"), "utf8");
    expect(p).toMatch(/^name = "laptop"$/m);
    expect(p).toMatch(/^url = "http:\/\/127.0.0.1:8740"$/m);
    expect(existsSync(join(ws, "secrets", "api-token"))).toBe(true);
    // A second init leaves the workspace alone.
    expect(cli(ws, "init", "--platform", "other")).toMatch(/leaving it alone/);
  });

  it("uses the reference platform file when the name matches", () => {
    const ws = join(mkdtempSync(join(tmpdir(), "oh-init-")), "workspace");
    cli(ws, "init", "--platform", "mac");
    const p = readFileSync(join(ws, "platforms", "mac.toml"), "utf8");
    expect(p).toMatch(/qwen3\.6-27b-q4km/);
    expect(p).toMatch(/^os = "macos"$/m);
  });
});
