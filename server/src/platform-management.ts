import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { Platform } from "./core/schemas.js";
const exec = promisify(execFile);

/** An OpenHelper API address: an HTTP(S) origin, nothing else. */
export function apiOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Enter an address like http://my-machine.example.ts.net:8740"); }
  if (!["http:","https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("API URL must be an HTTP(S) origin without credentials, path, or query");
  return url.origin;
}
export function validatePlatform(input: unknown): Platform {
  const p = Platform.parse(input);
  apiOrigin(p.url);
  if (p.auto_run && p.sandbox.driver === "none") throw new Error("Auto-run requires Docker, Podman, or Lima");
  for (const ref of [p.token_ref, p.ssh.auth_ref]) if (ref && !/^[A-Za-z0-9_-]{1,100}$/.test(ref)) throw new Error("Use a secret reference name, never a token or private key");
  for (const host of [p.tailscale_hostname,p.ssh.host]) if (host && !/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(host)) throw new Error("Use a hostname or IP address without a command or URL");
  if (p.tailscale_ipv4 && !z.ipv4().safeParse(p.tailscale_ipv4).success) throw new Error("Enter a valid Tailscale IPv4 address");
  if (p.ssh.user && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(p.ssh.user)) throw new Error("Invalid SSH username");
  return p;
}
export async function tailscaleStatus(run = exec) {
  try {
    const { stdout } = await run("tailscale", ["status", "--json"], { timeout: 4000, maxBuffer: 1024 * 1024 });
    const s = JSON.parse(String(stdout)) as { BackendState?: string; Self?: { DNSName?: string; HostName?: string; TailscaleIPs?: string[] } };
    return { available: true, online: s.BackendState === "Running", hostname: s.Self?.DNSName || s.Self?.HostName || "", ipv4: s.Self?.TailscaleIPs?.find(ip => z.ipv4().safeParse(ip).success) || "", instruction: "tailscale ip -4" };
  } catch { return { available: false, online: false, hostname: "", ipv4: "", instruction: "tailscale ip -4", message: "Tailscale is unavailable, signed out, or not responding. Install or open Tailscale, then refresh; direct API connections also work." }; }
}
/** Fixed command, batch mode, strict host verification. Keys are resolved by the OS SSH agent. */
export async function testSsh(p: Platform) {
  if (!p.ssh.host || !p.ssh.user || p.ssh.auth_ref !== "ssh-agent") throw new Error("SSH testing requires a host, user, and auth reference ssh-agent; load the key in your OS agent first");
  try {
    await exec("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=4", "-p", String(p.ssh.port), `${p.ssh.user}@${p.ssh.host}`, "echo openhelper-connected"], { timeout: 6000 });
    return { reachable: true };
  } catch { return { reachable: false, message: "SSH unavailable. Check the address, known host entry, and OS agent. No password prompts are allowed." }; }
}
