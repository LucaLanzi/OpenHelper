import type { HardwareInfo, ModelPack, ModelRole } from "./schemas.js";

/** Memory kept back for the OS, dashboard and sandbox. */
export const RESERVED_GB = 8;
/** KV cache budget added to a model file when checking fit. */
export const KV_BUDGET_GB = 3;

export type Tier = "XS" | "S" | "M" | "L" | "XL";

export const TIERS: { tier: Tier; min: number; max: number; notes: string }[] = [
  { tier: "XS", min: 0, max: 12, notes: "explain and small edits, 16k context, no reviewer" },
  { tier: "S", min: 12, max: 20, notes: "reviewer only by model swap" },
  { tier: "M", min: 20, max: 40, notes: "reference baseline: 2080 Ti desktop, 32 GB M1 Mac" },
  { tier: "L", min: 40, max: 80, notes: "reviewer loaded alongside; longer context" },
  { tier: "XL", min: 80, max: Number.POSITIVE_INFINITY, notes: "larger MoE, best-of-N in parallel slots" },
];

/**
 * Usable model memory:
 * - NVIDIA: VRAM + RAM - reserve (llama.cpp can keep MoE experts in RAM)
 * - Apple Silicon: unified memory - reserve
 * - CPU only: RAM - reserve
 */
export function usableMemoryGb(hw: HardwareInfo): number {
  const base = hw.unified_memory ? hw.ram_gb : hw.ram_gb + (hw.gpu.vendor === "nvidia" ? hw.gpu.vram_gb : 0);
  return Math.max(0, Math.round((base - RESERVED_GB) * 10) / 10);
}

export function tierFor(usableGb: number): Tier {
  const t = TIERS.find((x) => usableGb >= x.min && usableGb < x.max);
  return (t ?? TIERS[0]!).tier;
}

/** Does this model fit fully in fast memory (VRAM or unified)? Dense models only run well then. */
export function fitsFastMemory(hw: HardwareInfo, m: ModelPack): boolean {
  const fast = hw.unified_memory ? hw.ram_gb - RESERVED_GB : hw.gpu.vram_gb;
  return m.size_gb + KV_BUDGET_GB <= fast;
}

export function fits(hw: HardwareInfo, m: ModelPack): boolean {
  return m.size_gb + KV_BUDGET_GB <= usableMemoryGb(hw) && m.min_usable_gb <= usableMemoryGb(hw);
}

/**
 * Candidates for a role, best first. On machines that split a model between GPU and RAM,
 * MoE models are preferred over dense ones that don't fit in VRAM, because only active
 * experts are read per token.
 */
export function candidates(hw: HardwareInfo, models: ModelPack[], role: ModelRole): ModelPack[] {
  const split = !hw.unified_memory && hw.gpu.vendor === "nvidia";
  return models
    .filter((m) => m.roles.includes(role) && fits(hw, m))
    .sort((a, b) => score(b) - score(a));

  function score(m: ModelPack): number {
    let s = m.params_b; // bigger usually better, within what fits
    if (split && m.kind === "dense" && !fitsFastMemory(hw, m)) s -= 1000; // would crawl
    if (m.verified) s += 0.5;
    return s;
  }
}

/** Rough tokens/s ceiling: bandwidth / bytes read per token. Used for display only. */
export function speedCeilingTokS(bandwidthGbS: number, m: ModelPack): number {
  const bytesPerTokenGb = (m.active_params_b / m.params_b) * m.size_gb;
  return Math.round((bandwidthGbS / bytesPerTokenGb) * 10) / 10;
}

export interface SetupPlan {
  usable_gb: number;
  tier: Tier;
  main?: ModelPack;
  light?: ModelPack;
  reviewer?: ModelPack;
  embed?: ModelPack;
  disk_needed_gb: number;
  download_gb: number;
  warnings: string[];
}

/** Toolchains, docs, index, caches and working space, beyond model files. */
export const BASE_DISK_GB = 25;

export function makePlan(hw: HardwareInfo, models: ModelPack[], tierOverride?: Tier): SetupPlan {
  let usable = usableMemoryGb(hw);
  if (tierOverride) {
    const t = TIERS.find((x) => x.tier === tierOverride);
    if (!t) throw new Error(`unknown tier ${tierOverride}`);
    usable = Math.min(usable, t.max === Number.POSITIVE_INFINITY ? usable : t.max - 0.1);
  }
  const capped: HardwareInfo = { ...hw };
  const pick = (role: ModelRole) =>
    candidates(capped, models, role).find((m) => m.size_gb + KV_BUDGET_GB <= usable);
  const main = pick("main");
  const light = pick("light");
  const reviewer = candidates(capped, models, "reviewer").find(
    (m) => m.family !== main?.family && m.size_gb + KV_BUDGET_GB <= usable,
  );
  const embed = pick("embed");
  const chosen = [main, light, reviewer, embed].filter((m): m is ModelPack => Boolean(m));
  const download = chosen.reduce((s, m) => s + m.size_gb, 0);
  const warnings: string[] = [];
  if (!main) warnings.push("No main model fits this machine. Add a smaller model pack or free memory.");
  for (const m of chosen) {
    if (!m.verified) warnings.push(`${m.id}: not verified yet (hash and eval pending).`);
    if (!m.sha256) warnings.push(`${m.id}: no pinned SHA-256; it will be recorded on first download.`);
  }
  if (hw.unified_memory && main && main.size_gb + KV_BUDGET_GB > hw.ram_gb * 0.66) {
    warnings.push("macOS GPU memory limit (iogpu.wired_limit_mb) must be raised for this model; setup will ask first.");
  }
  const disk = Math.round((download + BASE_DISK_GB) * 1.2);
  if (hw.free_disk_gb < disk) warnings.push(`Free disk ${hw.free_disk_gb} GB is below the ${disk} GB needed.`);
  return {
    usable_gb: usable,
    tier: tierFor(usable),
    ...(main ? { main } : {}),
    ...(light ? { light } : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(embed ? { embed } : {}),
    disk_needed_gb: disk,
    download_gb: Math.round(download * 10) / 10,
    warnings,
  };
}
