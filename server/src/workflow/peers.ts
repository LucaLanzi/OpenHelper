import type { Platform } from "../core/schemas.js";
import { peerToken } from "../core/secrets.js";

/** Calls another platform's node API with that platform's token. */
export class PeerClient {
  constructor(private p: Platform) {}

  private token(): string {
    const t = peerToken(this.p.token_ref || this.p.name);
    if (!t) throw new Error(`no token for platform "${this.p.name}" in secrets/peers.toml`);
    return t;
  }

  async call<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const res = await fetch(`${this.p.url.replace(/\/+$/, "")}${path}`, {
      method,
      redirect: "error",
      headers: { authorization: `Bearer ${this.token()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${this.p.name} ${method} ${path}: ${res.status} (remote request failed; check the remote job log)`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async reachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.p.url.replace(/\/+$/, "")}/api/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
