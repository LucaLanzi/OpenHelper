import { useEffect, useRef, useState } from "react";
import { events, get, post, type Confidence, type Job, type JobSummary, type IndexEstimate as Estimate } from "../api";
import { IndexEstimate, IndexProgressView } from "../components/IndexEstimate";
import { Diff, Empty, ErrorNote, Markdown, PageHead, Signal, State, ago, useLoad, useToast } from "../components/ui";
import { ProjectPicker, useApp } from "../context";
import { go, href } from "../router";

const TYPES: { id: string; label: string; field?: string; hint?: string }[] = [
  { id: "explain", label: "Answer a question", field: "task" },
  { id: "plan", label: "Draft a plan", field: "task" },
  { id: "implement", label: "Implement a plan", field: "plan", hint: "Paste an approved plan. The change goes on a new branch." },
  { id: "check", label: "Run checks on the repo" },
  { id: "index", label: "Rebuild the search index" },
  { id: "mine", label: "Mine eval tasks from git history" },
  { id: "eval", label: "Run the eval" },
];

export function Jobs() {
  const { project } = useApp();
  const toast = useToast();
  const jobs = useLoad(() => get<JobSummary[]>("/jobs"));
  const [type, setType] = useState("explain");
  const [text, setText] = useState("");
  const [bestOf, setBestOf] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => events((ev) => ev === "job" && jobs.reload()), [jobs.reload]);
  const estimate = useLoad(() => type === "index" && project ? get<Estimate>(`/projects/${project}/estimate`) : Promise.resolve(null), [type,project]);
  const t = TYPES.find((x) => x.id === type)!;

  const create = async (start: boolean) => {
    setError(null);
    try {
      const input: Record<string, unknown> = t.field ? { [t.field]: text } : {};
      if (type === "implement" && bestOf > 1) input.best_of = bestOf;
      const j = await post<JobSummary>("/jobs", { type, project, input, start });
      toast(start ? "Job started" : "Job created; start it when you're ready");
      go("jobs", j.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <PageHead title="Jobs" intro="Work on this machine runs one job at a time, and only after you start it.">
        <ProjectPicker />
      </PageHead>
      <div className="panel stack">
        <label className="field">
          <span>What to do</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
          {t.hint && <span className="hint">{t.hint}</span>}
        </label>
        {t.field && (
          <label className="field">
            <span>{t.field === "plan" ? "Plan" : "Task"}</span>
            <textarea className={t.field === "plan" ? "code" : ""} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        )}
        {type === "implement" && (
          <label className="field" style={{ maxWidth: 240 }}>
            <span>Candidates</span>
            <select value={bestOf} onChange={(e) => setBestOf(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "1 (fastest)" : `best of ${n}`}
                </option>
              ))}
            </select>
          </label>
        )}
        {type === "index" && estimate.data && <IndexEstimate estimate={estimate.data}/>}
        <ErrorNote error={error || estimate.error} />
        <div className="row">
          <button className="primary" disabled={!project || (Boolean(t.field) && !text.trim())} onClick={() => void create(true)}>
            Start now
          </button>
          <button disabled={!project || (Boolean(t.field) && !text.trim())} onClick={() => void create(false)}>
            Create without starting
          </button>
        </div>
      </div>

      <div className="section">
        <h2>Recent jobs</h2>
        <ErrorNote error={jobs.error} />
        {jobs.data?.length ? (
          <div className="panel table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Project</th>
                  <th>Status</th>
                  <th>Result</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {jobs.data.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <a href={href("jobs", j.id)}>{TYPES.find((x) => x.id === j.type)?.label ?? j.type}</a>
                      {j.origin?.run_id && <div className="small muted">from a workflow{j.origin.from_platform && j.origin.from_platform !== j.platform ? ` on ${j.origin.from_platform}` : ""}</div>}
                    </td>
                    <td>{j.project || "—"}</td>
                    <td>
                      <State s={j.status} />
                    </td>
                    <td>{j.confidence ? <Signal status={j.confidence} /> : <span className="muted">—</span>}</td>
                    <td className="small muted">{ago(j.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No jobs yet">Create one above, or start a workflow.</Empty>
        )}
      </div>
    </>
  );
}

interface CheckRow {
  id: string;
  language: string;
  name: string;
  status: string;
  reason?: string;
  output: string;
  required: boolean;
}

export function JobView({ id }: { id: string }) {
  const toast = useToast();
  const job = useLoad(() => get<Job>(`/jobs/${id}`), [id]);
  const [lines, setLines] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => setLines(job.data?.log ?? []), [job.data]);
  useEffect(
    () =>
      events((ev, d) => {
        if (ev === "log" && (d as { id: string }).id === id) setLines((l) => [...l, (d as { line: string }).line]);
        if (ev === "job" && (d as JobSummary).id === id) job.reload();
      }),
    [id, job.reload],
  );
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  useEffect(() => { const t=window.setInterval(()=>job.reload(),3000);return ()=>window.clearInterval(t); },[job.reload]);
  const j = job.data;
  if (job.error) return <ErrorNote error={job.error} />;
  if (!j) return null;
  const o = (j.output ?? {}) as Record<string, unknown>;

  const act = async (what: "start" | "cancel") => {
    try {
      await post(`/jobs/${id}/${what}`);
      toast(what === "start" ? "Started" : "Canceled");
      job.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <>
      <PageHead title={TYPES.find((x) => x.id === j.type)?.label ?? j.type} intro={`${j.project || "no project"} on ${j.platform}${j.model ? `, model ${j.model}` : ""}, created ${ago(j.created_at)}`}>
        <State s={j.status} />
        {j.status === "created" && (
          <button className="primary" onClick={() => void act("start")}>
            Start job
          </button>
        )}
        {(j.status === "created" || j.status === "queued" || j.status === "running") && (
          <button className="danger" onClick={() => void act("cancel")}>
            Cancel job
          </button>
        )}
      </PageHead>
      {j.progress && <IndexProgressView progress={j.progress}/>}
      {j.error && <div className="notice error">{j.error}</div>}

      {j.type === "explain" && typeof o.answer === "string" && (
        <div className="panel stack">
          <Signal status={(o.confidence as { status: Confidence })?.status} reasons={(o.confidence as { reasons: string[] })?.reasons} />
          <div className="answer">
            <Markdown text={o.answer} />
          </div>
        </div>
      )}
      {j.type === "plan" && typeof o.plan === "string" && (
        <div className="panel stack">
          <p>
            Saved as <a href={href("plans", String(o.file))}>{String(o.file)}</a>. {String((o.citations as { valid: number })?.valid ?? 0)} claims cited, {String(o.unverified ?? 0)} marked
            unverified.
          </p>
          <Markdown text={o.plan} />
        </div>
      )}
      {j.type === "implement" && <ImplementResult o={o} />}
      {j.type === "check" && Array.isArray(o.results) && (
        <div className="stack">
          <Signal status={(o.confidence as { status: Confidence })?.status} reasons={(o.confidence as { reasons: string[] })?.reasons} />
          <Checks rows={o.results as CheckRow[]} />
        </div>
      )}
      {j.type === "eval" && typeof o.tasks === "number" && (
        <div className="panel stack-s">
          {o.errors_per_100 === null ? (
            <p>
              <strong>No task could be scored.</strong> Every task hit a problem outside the model's answer; see the log.
            </p>
          ) : (
            <p>
              <strong>
                {String(o.passed)} of {String(Number(o.tasks) - Number(o.infra_errors ?? 0))} scored tasks passed
              </strong>{" "}
              with {String(o.model)}: {String(o.errors_per_100)} errors and {String(o.hallucinations_per_100)} invented-API failures per 100 tasks.
              {o.green_precision !== null && ` When it said "Checked", it was right ${Math.round(Number(o.green_precision) * 100)}% of the time.`}
            </p>
          )}
          {Number(o.infra_errors ?? 0) > 0 && (
            <div className="notice">
              {String(o.infra_errors)} task{Number(o.infra_errors) === 1 ? "" : "s"} could not be run (for example the model server stopped responding) and
              {Number(o.infra_errors) === 1 ? " is" : " are"} left out of the score.
            </div>
          )}
        </div>
      )}
      {(j.type === "index" || j.type === "mine" || j.type === "docs") && j.status === "done" && (
        <pre>{JSON.stringify(o, null, 2)}</pre>
      )}

      <div className="section">
        <h2>Log</h2>
        <pre id="job-log" className="log mono" ref={logRef}>
          {lines.length ? lines.join("\n") : "Nothing logged yet."}
        </pre>
        <p className="small muted" style={{ marginTop: 8 }}>
          {j.usage.prompt_tokens + j.usage.completion_tokens > 0 && `${j.usage.prompt_tokens} prompt and ${j.usage.completion_tokens} generated tokens.`}
        </p>
      </div>
    </>
  );
}

function ImplementResult({ o }: { o: Record<string, unknown> }) {
  const best = o.best as
    | { branch: string; confidence: { status: Confidence; reasons: string[] }; checks: CheckRow[]; diff: string; attempts: number; edit_errors: string[]; hallucination: string[] }
    | undefined;
  if (!best) return null;
  const others = ((o.candidates as unknown[]) ?? []).length;
  return (
    <div className="stack">
      <div className="panel stack-s">
        <div className="row between">
          <Signal status={best.confidence.status} reasons={best.confidence.reasons} />
          <span className="small muted">
            {others > 1 ? `best of ${others} candidates, ` : ""}
            {best.attempts} attempt{best.attempts === 1 ? "" : "s"}
          </span>
        </div>
        <p>
          On branch <code>{best.branch}</code> in your repo. Nothing was merged.
        </p>
        {best.confidence.status !== "green" && <p className="small">{best.confidence.reasons.join(". ")}.</p>}
        {best.hallucination.length > 0 && <div className="notice error">Looks like an invented API: {best.hallucination.join("; ")}</div>}
      </div>
      <Checks rows={best.checks} />
      <Diff text={best.diff} />
    </div>
  );
}

function Checks({ rows }: { rows: CheckRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!rows.length) return <p className="muted">No checks apply to this project.</p>;
  return (
    <div className="panel table-wrap">
      <table>
        <thead>
          <tr>
            <th>Check</th>
            <th>Result</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const k = `${r.language}/${r.id}`;
            return (
              <tr key={k}>
                <td>
                  {r.name}
                  <div className="small muted">
                    {r.language}
                    {r.required ? "" : ", advisory"}
                  </div>
                </td>
                <td>
                  <State s={r.status === "pass" ? "done" : r.status === "skipped" ? "created" : "failed"} />{" "}
                  <span className="small">{r.status === "pass" ? "passed" : r.status === "skipped" ? "skipped" : r.status}</span>
                </td>
                <td>
                  {r.reason && <span className="small">{r.reason} </span>}
                  {r.output && (
                    <button className="quiet" onClick={() => setOpen(open === k ? null : k)} aria-expanded={open === k}>
                      {open === k ? "Hide output" : "Show output"}
                    </button>
                  )}
                  {open === k && <pre className="log">{r.output}</pre>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
