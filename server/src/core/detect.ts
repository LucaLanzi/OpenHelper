import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";
import os from "node:os";
import type { HardwareInfo } from "./schemas.js";

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
  } catch {
    return "";
  }
}

const gib = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

/** Detect what `./openhelper plan` needs: memory, GPU, disk. Nothing is sent anywhere. */
export function detectHardware(diskPath = process.cwd()): HardwareInfo {
  const platform = os.platform();
  const osName = platform === "linux" ? "linux" : platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "other";
  const cpus = os.cpus();
  let gpu: HardwareInfo["gpu"] = { vendor: "none", name: "", vram_gb: 0 };
  let unified = false;

  if (osName === "macos" && os.arch() === "arm64") {
    unified = true;
    const chip = run("sysctl", ["-n", "machdep.cpu.brand_string"]) || cpus[0]?.model || "Apple Silicon";
    gpu = { vendor: "apple", name: chip, vram_gb: 0 };
  } else {
    const smi = run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
    const first = smi.split("\n")[0];
    if (first) {
      const [name, mib] = first.split(",").map((s) => s.trim());
      gpu = { vendor: "nvidia", name: name ?? "NVIDIA GPU", vram_gb: Math.round((Number(mib) / 1024) * 10) / 10 };
    }
  }

  let free = 0;
  try {
    const st = statfsSync(diskPath);
    free = gib(Number(st.bavail) * Number(st.bsize));
  } catch {
    free = 0;
  }

  return {
    os: osName,
    arch: os.arch(),
    cpu: cpus[0]?.model?.trim() ?? "unknown",
    cores: cpus.length,
    ram_gb: gib(os.totalmem()),
    gpu,
    unified_memory: unified,
    free_disk_gb: free,
    detected_at: new Date().toISOString(),
  };
}
