import type { Platform, WorkflowDef } from "./schemas.js";
import { parseDuration, placeholders } from "./util.js";

/** Variables a step prompt may use. Outputs of earlier steps are added as {<step_id>}. */
export const BUILTIN_VARS = ["task", "plan", "patch", "project", "answer"];

/** "@plan" → the platform named in config aliases; plain names pass through. */
export function resolvePlatform(name: string, aliases: Record<string, string>): string {
  if (!name.startsWith("@")) return name;
  return aliases[name.slice(1)] ?? aliases[name] ?? name;
}

export function validateWorkflow(w: WorkflowDef, platforms: Platform[], aliases: Record<string, string> = {}): string[] {
  const errors: string[] = [];
  const names = new Set(platforms.map((p) => p.name));
  const seen = new Set<string>();
  try {
    parseDuration(w.limits.max_wall);
  } catch (e) {
    errors.push((e as Error).message);
  }
  for (const s of w.steps) {
    if (seen.has(s.id)) errors.push(`step "${s.id}" is defined twice`);
    const target = resolvePlatform(s.platform, aliases);
    if (!names.has(target)) {
      errors.push(
        s.platform.startsWith("@")
          ? `step "${s.id}": alias "${s.platform}" is not mapped in config.toml [aliases]`
          : `step "${s.id}": unknown platform "${s.platform}"`,
      );
    }
    const p = platforms.find((x) => x.name === target);
    if (p && !p.agents.includes(s.agent)) errors.push(`step "${s.id}": platform "${s.platform}" does not allow agent "${s.agent}"`);
    const allowed = new Set([...BUILTIN_VARS, ...w.inputs, ...seen]);
    for (const v of placeholders(s.prompt)) if (!allowed.has(v)) errors.push(`step "${s.id}": unknown placeholder {${v}}`);
    if (s.best_of > 1 && s.agent !== "coder") errors.push(`step "${s.id}": best_of only applies to coder steps`);
    seen.add(s.id);
  }
  if (w.steps.length > w.limits.max_hops + 1) errors.push(`${w.steps.length} steps exceed max_hops ${w.limits.max_hops}`);
  return errors;
}
