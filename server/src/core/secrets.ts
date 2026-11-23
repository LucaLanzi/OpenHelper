import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { ensureDir, readText, writeFileAtomic } from "./fsutil.js";
import { ws } from "./paths.js";
import { newToken } from "./util.js";

/**
 * secrets/api-token  this machine's API token (dashboard and other platforms use it)
 * secrets/peers.toml other platforms' tokens, keyed by platform name
 * Files are created with mode 600 and never leave the machine.
 */

const tokenFile = () => join(ws.secrets(), "api-token");
const peersFile = () => join(ws.secrets(), "peers.toml");

export function ensureApiToken(): string {
  ensureDir(ws.secrets());
  if (!existsSync(tokenFile())) {
    writeFileAtomic(tokenFile(), `${newToken()}\n`);
    chmodSync(tokenFile(), 0o600);
  }
  return apiToken();
}

export function apiToken(): string {
  if (process.env.OPENHELPER_TOKEN) return process.env.OPENHELPER_TOKEN;
  return readText(tokenFile()).trim();
}

export function peerToken(platform: string): string | undefined {
  const env = process.env[`OPENHELPER_TOKEN_${platform.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  if (env) return env;
  if (!existsSync(peersFile())) return undefined;
  const t = (parseToml(readText(peersFile())) as Record<string, unknown>)[platform];
  return typeof t === "string" ? t : undefined;
}
