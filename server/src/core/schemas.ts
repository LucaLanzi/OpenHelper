import { z } from "zod";

/** Packs and workspace files are validated with these schemas on load. */

export const ModelRole = z.enum(["main", "light", "reviewer", "draft", "embed"]);
export type ModelRole = z.infer<typeof ModelRole>;

export const ModelPack = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "lowercase id"),
  name: z.string(),
  family: z.string(),
  kind: z.enum(["dense", "moe"]),
  params_b: z.number().positive(),
  active_params_b: z.number().positive(),
  quant: z.string(),
  size_gb: z.number().positive(),
  roles: z.array(ModelRole).min(1),
  license: z.string(),
  min_usable_gb: z.number().positive(),
  ctx_default: z.number().int().positive().default(16384),
  tokenizer: z.string().default(""),
  source: z.object({
    hf_repo: z.string().default(""),
    filename: z.string().default(""),
    url: z.string().default(""),
  }),
  sha256: z.string().regex(/^([a-f0-9]{64})?$/).default(""),
  /** false until someone has downloaded it, checked the hash and run the eval. */
  verified: z.boolean().default(false),
  /** Default llama-server flags; platforms can override per model. */
  server_args: z.array(z.string()).default([]),
  notes: z.string().default(""),
});
export type ModelPack = z.infer<typeof ModelPack>;

export const CheckKind = z.enum(["syntax", "build", "test", "lint", "static"]);
export type CheckKind = z.infer<typeof CheckKind>;

export const CheckDef = z.object({
  id: z.string(),
  name: z.string(),
  kind: CheckKind,
  /** Shell command run in the project directory inside the sandbox. `{files}` expands to matched files. */
  run: z.string(),
  /** Binaries that must exist; if missing the check is skipped (and the status cannot be green). */
  requires: z.array(z.string()).default([]),
  /** Only run when one of these files exists (relative globs). */
  when_files: z.array(z.string()).default([]),
  /** Skip when one of these files exists (e.g. a plain compile check is skipped for CMake projects). */
  unless_files: z.array(z.string()).default([]),
  /** Lower runs first across all packs: builds before tests before linters that need build output. */
  order: z.number().int().default(50),
  /** Globs for `{files}` expansion. */
  files: z.array(z.string()).default([]),
  required: z.boolean().default(true),
  timeout_s: z.number().int().positive().default(300),
});
export type CheckDef = z.infer<typeof CheckDef>;

export const LanguagePack = z.object({
  id: z.string(),
  name: z.string(),
  detect: z.array(z.string()).min(1),
  source_globs: z.array(z.string()).min(1),
  test_globs: z.array(z.string()).default([]),
  docs: z.array(z.string()).default([]),
  lsp: z
    .object({ command: z.string(), args: z.array(z.string()).default([]) })
    .optional(),
  /** Regexes that indicate an invented API, used to classify eval failures. */
  hallucination_patterns: z.array(z.string()).default([]),
  checks: z.array(CheckDef).default([]),
});
export type LanguagePack = z.infer<typeof LanguagePack>;

const DocSourceFields = {
  url: z.string().url(),
  sha256: z.string().regex(/^([a-f0-9]{64})?$/).default(""),
  /** tar covers .tar.gz/.tar.xz/.tar.bz2; single files are indexed directly. */
  format: z.enum(["tar", "zip", "html", "markdown", "json", "text"]),
  /** Only index this folder or file inside the archive. */
  subdir: z.string().default(""),
};

export const DocSource = z.object({
  ...DocSourceFields,
  /** Tried in order when the main URL cannot be fetched, e.g. a release tarball on a mirror. */
  alternatives: z.array(z.object(DocSourceFields)).default([]),
});

export const DocPack = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  license: z.string(),
  /** If false, the pack is fetched by each user and never bundled. */
  redistributable: z.boolean().default(false),
  homepage: z.string().default(""),
  sources: z.array(DocSource).default([]),
  /** Alternative: index docs a local tool already installed (e.g. man pages). */
  local_command: z.string().default(""),
  verified: z.boolean().default(false),
  notes: z.string().default(""),
});
export type DocPack = z.infer<typeof DocPack>;

export const AgentKind = z.enum(["planner", "coder", "reviewer", "explainer"]);
export type AgentKind = z.infer<typeof AgentKind>;

export const WorkflowStep = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  platform: z.string(),
  agent: AgentKind,
  prompt: z.string(),
  gate: z.enum(["none", "human-approve"]).default("none"),
  checks: z.array(CheckKind).default([]),
  best_of: z.number().int().min(1).max(8).default(1),
  model: z.string().optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const WorkflowDef = z.object({
  name: z.string().regex(/^[a-z0-9_-]+$/),
  description: z.string().default(""),
  inputs: z.array(z.string()).default(["task"]),
  steps: z.array(WorkflowStep).min(1),
  limits: z
    .object({
      max_hops: z.number().int().positive().default(6),
      max_wall: z.string().default("2h"),
      max_tokens: z.number().int().positive().default(200000),
    })
    .default({ max_hops: 6, max_wall: "2h", max_tokens: 200000 }),
});
export type WorkflowDef = z.infer<typeof WorkflowDef>;

export const SandboxConfig = z.object({
  driver: z.enum(["none", "docker", "podman", "lima"]).default("none"),
  image: z.string().default("openhelper-sandbox:latest"),
  vm: z.string().default("openhelper"),
  /** Extra mounts are refused; only the worktree is mounted. Network is always off. */
});
export type SandboxConfig = z.infer<typeof SandboxConfig>;

export const ModelOverride = z.object({
  n_cpu_moe: z.number().int().nonnegative().optional(),
  ctx: z.number().int().positive().optional(),
  extra_args: z.array(z.string()).default([]),
});

export const Platform = z.object({
  name: z.string().regex(/^[a-z0-9_-]+$/),
  description: z.string().default(""),
  /** Base URL of this platform's node service, as reachable from the control plane. */
  url: z.string().url(),
  os: z.enum(["linux", "macos", "other"]).default("linux"),
  /** Name of the env var or secrets file key that holds this node's token. */
  token_ref: z.string().default(""),
  model: z.object({
    /** Default model; the dashboard can swap at runtime (stored in workspace/state/). */
    current: z.string(),
    /** Models offered in the dashboard picker; empty means every registry model that fits. */
    allowed: z.array(z.string()).default([]),
    /** Embedding model for hybrid search; empty means keyword search only. */
    embed: z.string().default(""),
    /** Default model for the light role (e.g. /explain), if set. */
    light: z.string().default(""),
  }),
  model_overrides: z.record(z.string(), ModelOverride).default({}),
  resources: z
    .object({
      unload_after_min: z.number().int().positive().default(30),
      /** Batch jobs only run when a person starts them. */
      batch_jobs: z.enum(["manual"]).default("manual"),
    })
    .default({ unload_after_min: 30, batch_jobs: "manual" }),
  sandbox: SandboxConfig.default({ driver: "none", image: "openhelper-sandbox:latest", vm: "openhelper" }),
  /** Agents this platform may run. */
  agents: z.array(AgentKind).default(["planner", "coder", "reviewer", "explainer"]),
  /** Run generated code automatically. Refused unless a sandbox driver other than none is set. */
  auto_run: z.boolean().default(false),
  /** Measured values written by `./openhelper detect` and benchmarks. */
  measured: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type Platform = z.infer<typeof Platform>;

export const LinkMode = z.enum(["isolated", "one-way", "two-way"]);
export type LinkMode = z.infer<typeof LinkMode>;

export const Link = z.object({
  from: z.string(),
  to: z.string(),
  mode: LinkMode.default("isolated"),
  budget: z
    .object({
      max_hops: z.number().int().positive().default(6),
      max_tokens: z.number().int().positive().default(200000),
      max_wall_min: z.number().int().positive().default(120),
    })
    .default({ max_hops: 6, max_tokens: 200000, max_wall_min: 120 }),
});
export type Link = z.infer<typeof Link>;

export const LinksFile = z.object({
  kill_switch: z.boolean().default(false),
  links: z.array(Link).default([]),
});
export type LinksFile = z.infer<typeof LinksFile>;

export const Project = z.object({
  name: z.string().regex(/^[a-z0-9_-]+$/),
  description: z.string().default(""),
  repos: z.array(z.string()).min(1),
  languages: z.array(z.string()).default([]),
  docs: z.array(z.string()).default([]),
  model: z.string().default(""),
  light_model: z.string().default(""),
  adapter: z.string().default(""),
  /** Glob patterns never indexed or sent to the model. */
  exclude: z.array(z.string()).default([]),
});
export type Project = z.infer<typeof Project>;

export const WorkspaceConfig = z.object({
  /** Which platform file describes this machine. */
  self: z.string(),
  roles: z.array(z.enum(["node", "control"])).default(["node", "control"]),
  bind: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(8740),
  /** llama-swap (or llama-server router) endpoint, localhost only. */
  llm_url: z.string().url().default("http://127.0.0.1:8741"),
  repair_attempts: z.number().int().min(0).max(5).default(2),
  /** Upper limit on generated tokens per model call (reasoning included). */
  max_tokens: z.number().int().positive().default(8192),
  /** Which steps let the model think before answering. Thinking helps planning but costs minutes on a laptop. */
  reasoning: z
    .object({
      plan: z.boolean().default(true),
      implement: z.boolean().default(true),
      repair: z.boolean().default(false),
      review: z.boolean().default(false),
      explain: z.boolean().default(false),
    })
    .default({ plan: true, implement: true, repair: false, review: false, explain: false }),
  retrieval_top_k: z.number().int().min(0).max(40).default(8),
  /** Workflow packs name roles like "@plan" and "@build"; map them to your platforms here. */
  aliases: z.record(z.string(), z.string()).default({}),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfig>;

export const HardwareInfo = z.object({
  os: z.enum(["linux", "macos", "other"]),
  arch: z.string(),
  cpu: z.string(),
  cores: z.number(),
  ram_gb: z.number(),
  gpu: z
    .object({ vendor: z.enum(["nvidia", "apple", "none", "other"]), name: z.string(), vram_gb: z.number() })
    .default({ vendor: "none", name: "", vram_gb: 0 }),
  unified_memory: z.boolean().default(false),
  free_disk_gb: z.number(),
  detected_at: z.string(),
});
export type HardwareInfo = z.infer<typeof HardwareInfo>;
