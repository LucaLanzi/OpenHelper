import { useRef, useState } from "react";
import { postStream, type Confidence } from "../api";
import { Empty, ErrorNote, Markdown, PageHead, Signal } from "../components/ui";
import { ProjectPicker, useApp } from "../context";
import { href } from "../router";

interface Source {
  label: string;
  source: string;
  path: string;
  start_line: number;
  end_line: number;
}

export function Ask() {
  const { project, projects } = useApp();
  const [q, setQ] = useState("");
  const [light, setLight] = useState(false);
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [done, setDone] = useState<{ model: string; confidence: { status: Confidence; reasons: string[] } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const ask = async () => {
    if (!q.trim() || !project) return;
    setAnswer("");
    setSources([]);
    setDone(null);
    setError(null);
    setStreaming(true);
    abort.current = new AbortController();
    try {
      await postStream(
        "/chat",
        { project, message: q, light },
        (ev, data) => {
          if (ev === "sources") setSources(data as Source[]);
          if (ev === "delta") setAnswer((a) => a + (data as string));
          if (ev === "done") setDone(data as typeof done);
          if (ev === "error") setError((data as { error: string }).error);
        },
        abort.current.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setStreaming(false);
    }
  };

  if (!projects.length) {
    return (
      <>
        <PageHead title="Ask" />
        <Empty title="Add a project first">
          Answers come from your own code and docs. Add a project on the <a href={href("projects")}>Projects</a> page.
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHead title="Ask" intro="Questions about your code or a language. Every claim should point at a source; anything it can't back up is marked unverified.">
        <ProjectPicker />
      </PageHead>
      <div className="panel stack">
        <label className="field">
          <span>Question</span>
          <textarea
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Why does this Makefile rebuild every time? / How does std::move work? / Where is the telemetry parser?"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void ask();
            }}
          />
        </label>
        <div className="row between">
          <label className="check">
            <input type="checkbox" checked={light} onChange={(e) => setLight(e.target.checked)} />
            Use the light model (faster, less thorough)
          </label>
          <div className="row">
            {streaming && <button onClick={() => abort.current?.abort()}>Stop</button>}
            <button className="primary" onClick={() => void ask()} disabled={streaming || !q.trim()}>
              Ask
            </button>
          </div>
        </div>
      </div>
      <ErrorNote error={error} />
      {(answer || streaming) && (
        <div className="panel stack" style={{ marginTop: 16 }} aria-live="polite">
          <div className="row between">
            {done ? <Signal status={done.confidence.status} reasons={done.confidence.reasons} /> : <span className="muted small">Answering…</span>}
            {done && <span className="small muted">{done.model}</span>}
          </div>
          <div className={`answer${streaming ? " streaming" : ""}`}>
            <Markdown text={answer} />
          </div>
          {done && done.confidence.status !== "green" && <p className="small muted">{done.confidence.reasons.join(". ")}.</p>}
          {sources.length > 0 && (
            <div>
              <h3 style={{ marginBottom: 8 }}>Sources</h3>
              <ul className="list">
                {sources.map((s) => (
                  <li key={s.label}>
                    <span className="cite">{s.label}</span> <code>{s.path}</code>{" "}
                    <span className="small muted">
                      lines {s.start_line}–{s.end_line}, {s.source.replace(/^(repo|doc):/, "")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </>
  );
}
