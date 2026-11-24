import { randomBytes, timingSafeEqual } from "node:crypto";

/** "90s", "15m", "2h", "1h30m" → milliseconds. */
export function parseDuration(s: string): number {
  const re = /(\d+)\s*(ms|s|m|h|d)/g;
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(re)) {
    matched = true;
    const n = Number(m[1]);
    const unit = m[2];
    total += n * (unit === "ms" ? 1 : unit === "s" ? 1e3 : unit === "m" ? 6e4 : unit === "h" ? 36e5 : 864e5);
  }
  if (!matched) throw new Error(`invalid duration "${s}"`);
  return total;
}

/** Replace {name} placeholders; unknown names are left visible so mistakes are obvious. */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (whole, name: string) => (name in vars ? vars[name]! : whole));
}

export function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([a-z_][a-z0-9_]*)\}/gi)].map((m) => m[1]!);
}

export function newId(prefix: string): string {
  const t = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${prefix}-${t}-${randomBytes(3).toString("hex")}`;
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function slugify(s: string, max = 40): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "task"
  );
}

export function tail(s: string, max = 4000): string {
  return s.length <= max ? s : `…${s.slice(-max)}`;
}

/** Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char, `{a,b}` alternatives. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      const alts = glob.slice(i + 1, end).split(",").map(escapeRe);
      re += `(?:${alts.join("|")})`;
      i = end;
    } else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
