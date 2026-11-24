import { useEffect, useState } from "react";
import { events, get, post, type Run, type Workflow } from "../api";
import { Diff, Empty, ErrorNote, Markdown, PageHead, State, ago, useLoad, useToast } from "../components/ui";
import { ProjectPicker, useApp } from "../context";
import { go, href } from "../router";

const AGENT_WORD: Record<string, string> = { planner: "Plan", coder: "Implement", reviewer: "Review", explainer: "Answer" };

export function Workflows() {
  const { project, projects } = useApp();
  const toast = useToast();
  const workflows = useLoad(() => get<Workflow[]>("/workflows"));
  const runs = useLoad(() => get<Run[]>("/runs"));
  const [picked, setPicked] = useState("");
  const [task, setTask] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => events((ev) => ev === "run" && runs.reload()), [runs.reload]);
  useEffect(() => {
    if (!picked && workflows.data?.length) setPicked(workflows.data[0]!.name);
  }, [workflows.data, picked]);

  const wf = workflows.data?.find((w) => w.name === picked);

  const start = async () => {
    setError(null);
    try {
      const r = await post<Run>(`/workflows/${picked}/run`, { project, inputs: { task } });
      toast(`Started ${picked}`);
      go("runs", r.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <PageHead title="Workflows" intro="A short prompt, run as steps across your machines. You approve the plan before any code is written.">
        <ProjectPicker />
      </PageHead>
      <ErrorNote error={workflows.error} />
      {!projects.length ? (
        <Empty title="Add a project first">Workflows run against a project's repos.</Empty>
      ) : (
        <div className="panel stack">
          <label className="field">
            <span>Workflow</span>
            <select value={picked} onChange={(e) => setPicked(e.target.value)}>
              {workflows.data?.map((w) => (
                <option key={w.name} value={w.name}>
                  {w.name}
                </option>
              ))}
            </select>
            {wf && <span className="hint">{wf.description}</span>}
          </label>
          {wf && (
            <ol className="steps" aria-label="Steps">
              {wf.steps.map((s) => (
                <li key={s.id}>
                  <strong>{AGENT_WORD[s.agent] ?? s.agent}</strong> on {s.platform}
                  {s.gate === "human-approve" ? ", then you approve" : ""}
                  {s.best_of > 1 ? `, best of ${s.best_of}` : ""}
                </li>
              ))}
            </ol>
          )}
          {wf?.errors.length ? <div className="notice error">This workflow can't run here: {wf.errors.join("; ")}</div> : null}
          <label className="field">
            <span>Task</span>
            <textarea value={task} onChange={(e) => setTask(e.target.value)} placeholder="Add a CRC check to the telemetry packet parser" />
          </label>
          <ErrorNote error={error} />
          <div className="row">
            <button className="primary" disabled={!task.trim() || !wf || wf.errors.length > 0} onClick={() => void start()}>
              Start workflow
            </button>
          </div>
        </div>
      )}

      <div className="section">
        <h2>Runs</h2>
        {runs.data?.length ? (
          <ul className="list panel">
            {runs.data.map((r) => (
              <li key={r.id}>
                <a className="item" href={href("runs", r.id)}>
                  <div className="row between">
                    <strong>{r.inputs.task?.split("\n")[0] ?? r.workflow}</strong>
                    <State s={r.status} />
                  </div>
                  <span className="small muted">
                    {r.workflow} on {r.project}, {ago(r.started_at)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No runs yet">Start a workflow above.</Empty>
        )}
      </div>
    </>
  );
}

export function RunView({ id }: { id: string }) {
  const { self } = useApp();
  const toast = useToast();
  const run = useLoad(() => get<Run>(`/runs/${id}`), [id]);
  const [edited, setEdited] = useState<string | null>(null);

  useEffect(() => events((ev, d) => ev === "run" && (d as Run).id === id && run.reload()), [id, run.reload]);
  useEffect(() => setEdited(null), [run.data?.gate?.step]);

  const r = run.data;
  if (run.error) return <ErrorNote error={run.error} />;
  if (!r) return null;

  const act = async (what: "approve" | "reject" | "cancel") => {
    try {
      await post(`/runs/${id}/${what}`, what === "approve" && edited !== null ? { content: edited } : {});
      toast(what === "approve" ? "Approved" : what === "reject" ? "Rejected" : "Canceled");
      run.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const gateStep = r.steps.find((s) => s.id === r.gate?.step);
  return (
    <>
      <PageHead title={r.inputs.task?.split("\n")[0] ?? r.workflow} intro={`${r.workflow} on ${r.project}, started ${ago(r.started_at)}`}>
        <State s={r.status} />
        {(r.status === "running" || r.status === "waiting-approval") && (
          <button className="danger" onClick={() => void act("cancel")}>
            Cancel run
          </button>
        )}
      </PageHead>
      {r.error && <div className={`notice${r.status === "refused" ? "" : " error"}`}>{r.error}</div>}

      <ol className="steps panel" style={{ paddingTop: 16 }}>
        {r.steps.map((s) => (
          <li key={s.id} className={s.status}>
            <div className="row between">
              <strong>
                {AGENT_WORD[s.agent] ?? s.agent} on {s.platform}
              </strong>
              <State s={s.status} />
            </div>
            {s.summary && <p className="small">{s.summary}</p>}
            {s.error && <p className="small" style={{ color: "var(--stop)" }}>{s.error}</p>}
            {s.job_id && s.platform === self && <a className="small" href={href("jobs", s.job_id)}>Job log</a>}
          </li>
        ))}
      </ol>

      {r.status === "waiting-approval" && r.gate && (
        <div className="panel stack" style={{ marginTop: 16 }}>
          <h2>{gateStep?.agent === "reviewer" ? "Review the result" : "Read and refine the plan"}</h2>
          <p className="muted">
            {gateStep?.agent === "reviewer"
              ? "The reviewer's notes and the patch are below. Approve to finish; the change stays on its branch for you to merge."
              : "Edit anything you disagree with. The coder works from exactly what you approve, and may only run the commands it lists."}
          </p>
          {gateStep?.agent === "reviewer" ? (
            <Markdown text={r.gate.content} />
          ) : (
            <textarea className="code" value={edited ?? r.gate.content} onChange={(e) => setEdited(e.target.value)} aria-label="Plan" />
          )}
          <div className="row">
            <button className="primary" onClick={() => void act("approve")}>
              {gateStep?.agent === "reviewer" ? "Approve" : edited !== null ? "Approve edited plan" : "Approve plan"}
            </button>
            <button onClick={() => void act("reject")}>Reject</button>
          </div>
        </div>
      )}

      {r.vars.patch && (
        <div className="section">
          <h2>Patch</h2>
          {r.vars.branch && (
            <p className="muted" style={{ marginBottom: 8 }}>
              On branch <code>{r.vars.branch}</code>. Nothing is merged for you.
            </p>
          )}
          {r.vars.checks && <pre style={{ marginBottom: 12 }}>{r.vars.checks}</pre>}
          <Diff text={r.vars.patch} />
        </div>
      )}
      {r.vars.review && r.status !== "waiting-approval" && (
        <div className="section">
          <h2>Review</h2>
          <div className="panel">
            <Markdown text={r.vars.review} />
          </div>
        </div>
      )}
      {r.vars.answer && (
        <div className="section panel">
          <Markdown text={r.vars.answer} />
        </div>
      )}
    </>
  );
}
