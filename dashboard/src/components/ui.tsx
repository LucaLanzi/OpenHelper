import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Confidence } from "../api";

// ---------------------------------------------------------------- confidence signal

const SIGNAL_WORD: Record<Confidence, string> = { green: "Checked", amber: "Partly checked", red: "Failed checks" };

/** Word + shape + colour, so the signal never depends on colour alone. */
export function Signal({ status, reasons }: { status: Confidence | null | undefined; reasons?: string[] }) {
  if (!status) return <span className="signal neutral">Not checked</span>;
  return (
    <span className={`signal ${status}`} title={reasons?.join("\n")}>
      {SIGNAL_WORD[status]}
    </span>
  );
}

const STATE_WORD: Record<string, string> = {
  created: "Not started",
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  canceled: "Canceled",
  refused: "Refused by link",
  "waiting-approval": "Waiting for you",
  pending: "Pending",
};

export function State({ s }: { s: string }) {
  return <span className={`state ${s}`}>{STATE_WORD[s] ?? s}</span>;
}

// ---------------------------------------------------------------- toast

const ToastCtx = createContext<(msg: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && (
        <div className="toast" role="status" aria-live="polite">
          {msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ---------------------------------------------------------------- data loading

export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    load()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => reload(), [reload]);
  return { data, error, loading, reload, setData };
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <div className="notice error" role="alert">
      {error}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function PageHead({ title, intro, children }: { title: string; intro?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {intro && <p>{intro}</p>}
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- text rendering

export function Diff({ text }: { text: string }) {
  if (!text.trim()) return <p className="muted">No changes.</p>;
  return (
    <pre className="diff" aria-label="Patch">
      {text.split("\n").map((l, i) => {
        const cls = l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : "";
        return (
          <span key={i} className={cls}>
            {l || " "}
          </span>
        );
      })}
    </pre>
  );
}

/** Small, safe Markdown: headings, lists, code fences, inline code, bold, citations. No raw HTML. */
export function Markdown({ text, className = "md" }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      blocks.push(<pre key={key++}>{code.join("\n")}</pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) {
      const level = Math.min(3, h[1]!.length + 1);
      const Tag = `h${level}` as "h2" | "h3";
      blocks.push(<Tag key={key++}>{inline(h[2]!)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={key++}>
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (!l.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s)/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={key++}>{inline(para.join(" "))}</p>);
  }
  return <div className={className}>{blocks}</div>;
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[S\d+\])/g;
  let last = 0;
  let k = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("`")) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else out.push(<span key={k++} className="cite">{t.slice(1, -1)}</span>);
    last = m.index! + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

export function ago(iso?: string): string {
  if (!iso) return "";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
