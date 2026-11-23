export interface Chunk {
  id: string;
  /** "repo:<name>" or "doc:<pack>" */
  source: string;
  path: string;
  start_line: number;
  end_line: number;
  title: string;
  text: string;
}

const MD_HEADING = /^#{1,4}\s+(.+)$/;
const RST_UNDERLINE = /^([=\-~^"'`#*+])\1{3,}\s*$/;

/** Markdown and reStructuredText: split at headings, then cap size. */
export function chunkProse(source: string, path: string, text: string, maxLines = 80): Chunk[] {
  const lines = text.split("\n");
  const out: Chunk[] = [];
  let start = 0;
  let title = path;
  const flush = (end: number) => {
    if (end <= start) return;
    for (let s = start; s < end; s += maxLines) {
      const e = Math.min(end, s + maxLines);
      const body = lines.slice(s, e).join("\n").trim();
      if (body.length > 20) out.push(mk(source, path, s, e, title, body));
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const md = MD_HEADING.exec(l);
    const rst = i > 0 && RST_UNDERLINE.test(l) && lines[i - 1]!.trim().length > 0 && lines[i - 1]!.trim().length <= l.trim().length + 2;
    if (md || rst) {
      const at = rst ? i - 1 : i;
      flush(at);
      start = at;
      title = md ? md[1]!.trim() : lines[i - 1]!.trim();
    }
  }
  flush(lines.length);
  return out;
}

/** Code: fixed windows with overlap, starting new windows at blank lines when possible. */
export function chunkCode(source: string, path: string, text: string, window = 60, overlap = 10): Chunk[] {
  const lines = text.split("\n");
  const out: Chunk[] = [];
  let s = 0;
  while (s < lines.length) {
    let e = Math.min(lines.length, s + window);
    // Prefer to end on a blank line within the last 15 lines of the window.
    for (let k = e; k > s + window - 15 && k < lines.length; k--) {
      if (lines[k]!.trim() === "") {
        e = k;
        break;
      }
    }
    const body = lines.slice(s, e).join("\n");
    if (body.trim()) out.push(mk(source, path, s, e, `${path}:${s + 1}`, body));
    if (e >= lines.length) break;
    s = Math.max(e - overlap, s + 1);
  }
  return out;
}

const PROSE_EXT = /\.(md|markdown|rst|txt|adoc)$/i;

export function chunkFile(source: string, path: string, text: string): Chunk[] {
  return PROSE_EXT.test(path) ? chunkProse(source, path, text) : chunkCode(source, path, text);
}

function mk(source: string, path: string, s: number, e: number, title: string, text: string): Chunk {
  return { id: `${source}|${path}|${s + 1}`, source, path, start_line: s + 1, end_line: e, title, text };
}

/** Very small HTML → text: drops scripts/styles/nav, keeps headings as Markdown. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|nav|header|footer)[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n${"#".repeat(Number(n))} ${stripTags(t).trim()}\n`)
    .replace(/<(pre|code)[^>]*>/gi, "\n```\n")
    .replace(/<\/(pre)>/gi, "\n```\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|dt|dd|table|section)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

/** Node.js all.json → one Markdown section per module, method, property and event. */
export function nodeApiJsonToMarkdown(json: unknown): string {
  const out: string[] = [];
  const walk = (node: Record<string, unknown>, depth: number) => {
    const name = (node.textRaw as string) ?? (node.name as string) ?? "";
    if (name) out.push(`${"#".repeat(Math.min(4, depth))} ${name}`);
    if (typeof node.desc === "string") out.push(htmlToText(node.desc));
    for (const key of ["modules", "classes", "methods", "properties", "events", "globals", "miscs", "signatures"]) {
      const arr = node[key];
      if (Array.isArray(arr)) for (const child of arr) if (child && typeof child === "object") walk(child as Record<string, unknown>, depth + 1);
    }
  };
  if (json && typeof json === "object") walk(json as Record<string, unknown>, 1);
  return out.join("\n\n");
}
