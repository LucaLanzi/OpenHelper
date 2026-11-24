/** Thin client for the engine API. The token lives in this browser only. */

const KEY = "openhelper.token";

export function getToken(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(t: string): void {
  try {
    if (t) localStorage.setItem(KEY, t);
    else localStorage.removeItem(KEY);
  } catch {
    // private mode: the token lasts for this tab only
  }
  memToken = t;
}

let memToken = getToken();

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${memToken || getToken()}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error ?? `${res.status} ${res.statusText}`;
    if (res.status === 401) window.dispatchEvent(new Event("openhelper:unauthorized"));
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const get = <T>(p: string) => api<T>("GET", p);
export const post = <T>(p: string, b: unknown = {}) => api<T>("POST", p, b);
export const del = <T>(p: string, b: unknown = { confirm: true }) => api<T>("DELETE", p, b);
export const put = <T>(p: string, b: unknown) => api<T>("PUT", p, b);

/** Calls a platform's node API: directly for this machine, through the control plane for others. */
export function nodePath(platform: string, self: string, path: string): string {
  return platform === self ? path : `/peer/${platform}${path}`;
}

/** Streams server-sent events from a POST (used by Ask). */
export async function postStream(path: string, body: unknown, on: (event: string, data: unknown) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${memToken || getToken()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) throw new ApiError(res.status, (await res.text()) || res.statusText);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(chunk)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (data !== undefined) on(ev, JSON.parse(data));
    }
  }
}

/** Live updates (jobs, logs, runs, queue) for this machine. */
export function events(on: (event: string, data: unknown) => void): () => void {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(memToken || getToken())}`);
  for (const name of ["job", "log", "run", "queue"]) {
    es.addEventListener(name, (e) => on(name, JSON.parse((e as MessageEvent).data as string)));
  }
  return () => es.close();
}

// ---- shapes the pages use ------------------------------------------------------------

export type Confidence = "green" | "amber" | "red";

export interface Status {
  platform: string;
  description: string;
  model: string;
  default_model: string;
  loaded: string[];
  llm_healthy: boolean;
  queue: { paused: boolean; running?: string; queued: number; pending_swap?: string };
  sandbox: string;
  auto_run: boolean;
}

export interface PlatformInfo {
  display_name: string;
  connection: string;
  tailscale_hostname: string;
  tailscale_ipv4: string;
  token_ref: string;
  ssh: { host: string; port: number; user: string; auth_ref: string };
  agents: string[];
  hooks: string[];
  sandbox: { driver: string; image: string; vm: string };
  auto_run: boolean;
  measured: Record<string, string | number | boolean>;
  last_success?: string;
  name: string;
  description: string;
  url: string;
  os: string;
  self: boolean;
  reachable: boolean;
  status?: Status;
  error?: string;
  model: { current: string; allowed: string[]; light: string; embed: string };
}

export interface ModelInfo {
  id: string;
  name: string;
  kind: string;
  size_gb: number;
  roles: string[];
  verified: boolean;
  license: string;
}

export interface JobSummary {
  id: string;
  type: string;
  project: string;
  platform: string;
  model: string;
  status: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  progress?: IndexProgress;
  confidence: Confidence | null;
  origin?: { run_id?: string; step?: string; from_platform?: string };
}

export interface Job extends Omit<JobSummary, "confidence"> {
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  log: string[];
  usage: { prompt_tokens: number; completion_tokens: number };
}

export interface Project {
  platform: string;
  model: string;
  light_model: string;
  search: string;
  embed_model: string;
  exclude: string[];
  language_mode: string;
  checks?: string[];
  name: string;
  description: string;
  repos: string[];
  languages: string[];
  docs: string[];
  index: { chunks: number; built_at: string; dims: number; sources: Record<string, number>; redactions: number } | null;
  eval_tasks: number;
}

export interface StepState {
  id: string;
  platform: string;
  agent: string;
  status: string;
  job_id?: string;
  summary?: string;
  error?: string;
}

export interface Run {
  id: string;
  workflow: string;
  project: string;
  inputs: Record<string, string>;
  status: string;
  steps: StepState[];
  vars: Record<string, string>;
  hops: number;
  tokens: number;
  started_at: string;
  finished_at?: string;
  error?: string;
  gate?: { step: string; content: string };
}

export interface Workflow {
  name: string;
  description: string;
  inputs: string[];
  steps: { id: string; platform: string; agent: string; gate: string; best_of: number }[];
  errors: string[];
}

export interface LinksInfo {
  kill_switch: boolean;
  links: { from: string; to: string; mode: string; budget: { max_hops: number; max_tokens: number; max_wall_min: number } }[];
  matrix: { from: string; to: string; allowed: boolean; reason: string }[];
}

export interface DocPackInfo {
  id: string; name: string; version: string; license: string; sources: unknown[];
  local_command: string; homepage: string; notes: string; status: { fetched: boolean; files: number };
}
export interface LanguageInfo {
  id: string; name: string; detect: string[]; checks: string[]; sandbox: string; custom: boolean;
  details: { id: string; name: string; kind: string; requires: string[]; when_files: string[] }[];
}
export interface IndexEstimate {
  platform: string; min_s: number; max_s: number; basis: string; confidence: string; explanation: string;
}
export interface IndexProgress {
  phase: string; files_discovered: number; files_processed: number; chunks: number;
  embeddings_completed: number; elapsed_ms: number; eta_min_s: number; eta_max_s: number;
}
