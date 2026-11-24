import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, listFiles } from "./fsutil.js";
import { ws } from "./paths.js";

/**
 * Append-only audit log, one JSON line per event, one file per day.
 * Each entry carries the hash of the previous one, so edits to history are detectable.
 */
export interface AuditEvent {
  ts: string;
  actor: string;
  action: string;
  platform?: string;
  detail?: Record<string, unknown>;
  prev: string;
  hash: string;
}

let lastHash: string | undefined;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function fileFor(day: string): string {
  return join(ws.audit(), `${day}.jsonl`);
}

function tailHash(): string {
  if (lastHash) return lastHash;
  const files = listFiles(ws.audit(), [".jsonl"]);
  const f = files[files.length - 1];
  if (!f) return "genesis";
  const lines = readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
  const last = lines[lines.length - 1];
  return last ? (JSON.parse(last) as AuditEvent).hash : "genesis";
}

export function audit(actor: string, action: string, detail?: Record<string, unknown>, platform?: string): AuditEvent {
  ensureDir(ws.audit());
  const prev = tailHash();
  const base = { ts: new Date().toISOString(), actor, action, ...(platform ? { platform } : {}), ...(detail ? { detail } : {}), prev };
  const hash = createHash("sha256").update(JSON.stringify(base)).digest("hex");
  const ev: AuditEvent = { ...base, hash };
  appendFileSync(fileFor(today()), `${JSON.stringify(ev)}\n`);
  lastHash = hash;
  return ev;
}

/** For tests: forget the cached chain head (the workspace changed). */
export function resetAuditCache(): void {
  lastHash = undefined;
}

export function readAudit(limit = 200): AuditEvent[] {
  const files = listFiles(ws.audit(), [".jsonl"]).reverse();
  const out: AuditEvent[] = [];
  for (const f of files) {
    const lines = readFileSync(f, "utf8").trim().split("\n").filter(Boolean).reverse();
    for (const l of lines) {
      out.push(JSON.parse(l) as AuditEvent);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Recompute the chain; returns the index of the first broken entry, or -1. */
export function verifyAudit(): number {
  const files = listFiles(ws.audit(), [".jsonl"]);
  let prev = "genesis";
  let i = 0;
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const l of readFileSync(f, "utf8").trim().split("\n").filter(Boolean)) {
      const ev = JSON.parse(l) as AuditEvent;
      const { hash, ...base } = ev;
      const h = createHash("sha256").update(JSON.stringify(base)).digest("hex");
      if (ev.prev !== prev || h !== hash) return i;
      prev = hash;
      i++;
    }
  }
  return -1;
}
