import type { Link, LinksFile } from "./schemas.js";

export interface LinkDecision {
  allowed: boolean;
  reason: string;
  link?: Link;
}

/**
 * May an agent on `from` send work or messages to `to`?
 * Same platform is always allowed. Otherwise a link must exist and permit the direction.
 * The kill switch blocks every cross-platform message.
 */
export function canSend(file: LinksFile, from: string, to: string): LinkDecision {
  if (from === to) return { allowed: true, reason: "same platform" };
  if (file.kill_switch) return { allowed: false, reason: "kill switch is on" };
  for (const l of file.links) {
    if (l.mode === "isolated") continue;
    if (l.from === from && l.to === to) return { allowed: true, reason: `${l.mode} link ${l.from}→${l.to}`, link: l };
    if (l.mode === "two-way" && l.from === to && l.to === from) {
      return { allowed: true, reason: `two-way link ${l.from}↔${l.to}`, link: l };
    }
  }
  return { allowed: false, reason: `no link allows ${from}→${to} (platforms are isolated by default)` };
}

export interface BudgetUse {
  hops: number;
  tokens: number;
  started_at: number;
}

export function withinBudget(link: Link | undefined, use: BudgetUse, now = Date.now()): LinkDecision {
  if (!link) return { allowed: true, reason: "same platform" };
  const b = link.budget;
  if (use.hops > b.max_hops) return { allowed: false, reason: `hop budget ${b.max_hops} exceeded` };
  if (use.tokens > b.max_tokens) return { allowed: false, reason: `token budget ${b.max_tokens} exceeded` };
  if (now - use.started_at > b.max_wall_min * 60_000) {
    return { allowed: false, reason: `wall-time budget ${b.max_wall_min} min exceeded` };
  }
  return { allowed: true, reason: "within budget", link };
}

/** Every ordered pair of platforms with its effective mode, for the dashboard matrix. */
export function matrix(file: LinksFile, platforms: string[]): { from: string; to: string; allowed: boolean; reason: string }[] {
  const out: { from: string; to: string; allowed: boolean; reason: string }[] = [];
  for (const a of platforms) for (const b of platforms) if (a !== b) out.push({ from: a, to: b, ...canSend(file, a, b) });
  return out;
}
