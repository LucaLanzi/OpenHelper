import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { packsDir, repoRoot } from "../core/paths.js";
import type { SandboxConfig } from "../core/schemas.js";

export interface RunResult {
  code: number;
  output: string;
  timed_out: boolean;
  duration_ms: number;
}

export interface RunOptions {
  timeoutMs: number;
  /** Extra paths mounted read-only at the same location (e.g. the source repo, for node_modules symlinks). */
  readOnly?: string[];
}

/**
 * Generated code only ever runs through a sandbox. Container drivers mount just the worktree
 * (read-write) and the packs (read-only), with networking off.
 */
export interface Sandbox {
  driver: SandboxConfig["driver"];
  run(cmd: string, cwd: string, o: RunOptions): Promise<RunResult>;
}

const MAX_OUTPUT = 2 * 1024 * 1024;

function exec(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RunResult> {
  const t0 = Date.now();
  return new Promise((resolveRun) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let out = "";
    let timedOut = false;
    const onData = (d: Buffer) => {
      if (out.length < MAX_OUTPUT) out += d.toString("utf8");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveRun({ code: 127, output: `${out}\n${e.message}`, timed_out: false, duration_ms: Date.now() - t0 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code: timedOut ? 124 : (code ?? 1), output: out, timed_out: timedOut, duration_ms: Date.now() - t0 });
    });
  });
}

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  // Do not leak the server's environment (tokens, proxies) into generated code.
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    CI: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    ...extra,
  };
}

/** PATH for host checks, with the Python the macOS installer set up (vendor/check-python) first. */
function hostPath(): string {
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const bin = join(repoRoot(), "vendor", "check-python", "bin");
  return existsSync(bin) ? `${bin}:${path}` : path;
}

/** Runs on the host. Only for interactive use; platforms refuse auto_run with this driver. */
class HostSandbox implements Sandbox {
  driver = "none" as const;
  private unshare = canUnshareNet();
  run(cmd: string, cwd: string, o: RunOptions): Promise<RunResult> {
    const env = baseEnv({ OH_PACKS: packsDir(), PATH: hostPath() });
    // Where unprivileged user namespaces exist, still drop the network (loopback stays up,
    // because many test suites start local servers).
    if (this.unshare) return exec("unshare", ["-rn", "sh", "-c", 'ip link set lo up && exec sh -c "$0"', cmd], cwd, env, o.timeoutMs);
    return exec("sh", ["-c", cmd], cwd, env, o.timeoutMs);
  }
}

class ContainerSandbox implements Sandbox {
  constructor(
    public driver: "docker" | "podman",
    private image: string,
  ) {}
  run(cmd: string, cwd: string, o: RunOptions): Promise<RunResult> {
    const args = ["run", "--rm", "--network", "none", "--pids-limit", "512", "-v", `${cwd}:/work`, "-v", `${packsDir()}:/oh/packs:ro`];
    for (const p of o.readOnly ?? []) args.push("-v", `${p}:${p}:ro`);
    if (this.driver === "podman") args.push("--userns=keep-id");
    else if (process.getuid && process.getgid) args.push("--user", `${process.getuid()}:${process.getgid()}`);
    args.push("-w", "/work", "-e", "OH_PACKS=/oh/packs", "-e", "HOME=/tmp", "-e", "CI=1", "-e", "PYTHONDONTWRITEBYTECODE=1", this.image, "sh", "-c", cmd);
    return exec(this.driver, args, cwd, baseEnv({}), o.timeoutMs);
  }
}

/**
 * macOS: a Lima VM with containerd. `make sandbox-vm` creates Lima's default VM, whose containerd
 * runs rootless (plain `nerdctl`); a VM set up with system containerd needs `sudo nerdctl`.
 * Which one this VM has is detected once. The worktree must be under a writable Lima mount.
 */
class LimaSandbox implements Sandbox {
  driver = "lima" as const;
  private nerdctl?: Promise<string[]>;
  constructor(
    private vm: string,
    private image: string,
  ) {}

  private detect(): Promise<string[]> {
    // Ask for the image, not `nerdctl info`: that also succeeds on a VM whose containers live under sudo.
    this.nerdctl ??= exec("limactl", ["shell", this.vm, "--", "nerdctl", "image", "inspect", this.image], process.cwd(), baseEnv({}), 60_000).then((r) =>
      r.code === 0 ? ["nerdctl"] : ["sudo", "nerdctl"],
    );
    return this.nerdctl;
  }

  async run(cmd: string, cwd: string, o: RunOptions): Promise<RunResult> {
    const nerdctl = await this.detect();
    const args = ["shell", this.vm, "--", ...nerdctl, "run", "--rm", "--network", "none"];
    // System containerd applies AppArmor; its default profile stops test runners signalling their
    // own workers on current kernels, so use ours (scripts/lima-apparmor.sh). Rootless has no AppArmor.
    if (nerdctl[0] === "sudo") args.push("--security-opt", "apparmor=openhelper-sandbox");
    args.push("-v", `${cwd}:/work`, "-v", `${packsDir()}:/oh/packs:ro`);
    for (const p of o.readOnly ?? []) args.push("-v", `${p}:${p}:ro`);
    args.push("-w", "/work", "-e", "OH_PACKS=/oh/packs", "-e", "HOME=/tmp", "-e", "PYTHONDONTWRITEBYTECODE=1", this.image, "sh", "-c", cmd);
    return exec("limactl", args, cwd, baseEnv({}), o.timeoutMs);
  }
}

function canUnshareNet(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return spawnSync("unshare", ["-rn", "sh", "-c", "ip link set lo up"], { stdio: "ignore", timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
}

export function makeSandbox(cfg: SandboxConfig): Sandbox {
  switch (cfg.driver) {
    case "docker":
    case "podman":
      return new ContainerSandbox(cfg.driver, cfg.image);
    case "lima":
      return new LimaSandbox(cfg.vm, cfg.image);
    default:
      return new HostSandbox();
  }
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
