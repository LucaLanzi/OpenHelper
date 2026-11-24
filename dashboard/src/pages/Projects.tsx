import { useState } from "react";
import { get, post, type JobSummary } from "../api";
import { PathField } from "../components/PathField";
import { ErrorNote, PageHead, ago, useLoad, useToast } from "../components/ui";
import { useApp } from "../context";
import { go } from "../router";

interface EvalSummary {
  model: string;
  tasks: number;
  passed: number;
  errors_per_100: number | null;
  infra_errors?: number;
  hallucinations_per_100: number;
  green_precision: number | null;
  finished_at: string;
}

export function Projects() {
  const { projects, reloadProjects, setProject } = useApp();
  return (
    <>
      <PageHead title="Projects" intro="A project is one or more of your repos plus the docs the model should cite. Each gets its own search index, eval tasks and scores." />
      <div className="stack">
        <AddRepo
          onAdded={(name) => {
            reloadProjects();
            setProject(name);
          }}
        />
        {projects.map((p) => (
          <ProjectPanel key={p.name} name={p.name} onChange={reloadProjects} onUse={() => setProject(p.name)} />
        ))}
      </div>
    </>
  );
}

function AddRepo({ onAdded }: { onAdded: (name: string) => void }) {
  const toast = useToast();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ project: { name: string }; job: JobSummary }>("/projects", { path });
      toast(`Added ${r.project.name}; fetching its docs and building the index`);
      onAdded(r.project.name);
      go("jobs", r.job.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel stack-s" aria-label="Add a repo">
      <h2>Add a repo</h2>
      <PathField label="Git repo" kind="folder" value={path} onChange={setPath} placeholder="~/code/my-repo" />
      <ErrorNote error={error} />
      <div className="row">
        <button className="primary" onClick={() => void add()} disabled={busy || !path.trim()}>
          Add repo
        </button>
      </div>
    </section>
  );
}

function ProjectPanel({ name, onChange, onUse }: { name: string; onChange: () => void; onUse: () => void }) {
  const { projects } = useApp();
  const toast = useToast();
  const p = projects.find((x) => x.name === name)!;
  const results = useLoad(() => get<EvalSummary[]>(`/results/${name}`), [name]);
  const [error, setError] = useState<string | null>(null);

  const run = async (type: string, label: string) => {
    setError(null);
    try {
      const j = await post<JobSummary>("/jobs", { type, project: name, input: {}, start: true });
      toast(`${label} started`);
      onChange();
      go("jobs", j.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const detect = async () => {
    setError(null);
    try {
      const r = await post<{ languages: string[] }>(`/projects/${name}/detect`);
      toast(`Languages: ${r.languages.join(", ") || "none found"}`);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const latest = results.data?.[0];
  return (
    <section className="panel stack-s" aria-label={p.name}>
      <div className="row between">
        <h2>{p.name}</h2>
        <button className="quiet" onClick={onUse}>
          Use in Ask and Workflows
        </button>
      </div>
      <p className="small muted">{p.repos.join(", ")}</p>
      <table>
        <tbody>
          <tr>
            <th scope="row">Languages</th>
            <td>{p.languages.join(", ") || "detected when checks run"}</td>
          </tr>
          <tr>
            <th scope="row">Doc packs</th>
            <td>{p.docs.join(", ") || "none"}</td>
          </tr>
          <tr>
            <th scope="row">Search index</th>
            <td>
              {p.index
                ? `${p.index.chunks.toLocaleString()} passages, ${p.index.dims ? "keywords and embeddings" : "keywords only"}, built ${ago(p.index.built_at)}${p.index.redactions ? `; ${p.index.redactions} secrets redacted` : ""}`
                : "not built yet"}
            </td>
          </tr>
          <tr>
            <th scope="row">Eval tasks</th>
            <td>{p.eval_tasks ? `${p.eval_tasks} mined from git history` : "none yet"}</td>
          </tr>
          <tr>
            <th scope="row">Latest score</th>
            <td>
              {latest && latest.errors_per_100 === null
                ? `last eval could not score any task (${latest.infra_errors ?? latest.tasks} could not be run)`
                : latest
                ? `${latest.errors_per_100} errors per 100 tasks with ${latest.model} (${latest.passed}/${latest.tasks} passed, ${ago(latest.finished_at)})${latest.green_precision !== null ? `; "Checked" was right ${Math.round(latest.green_precision * 100)}% of the time` : ""}`
                : "no eval run yet"}
            </td>
          </tr>
        </tbody>
      </table>
      <ErrorNote error={error} />
      <div className="row">
        <button className="primary" onClick={() => void run("index", "Index build")}>
          {p.index ? "Rebuild index" : "Build index"}
        </button>
        <button onClick={() => void run("mine", "Task mining")}>Mine eval tasks</button>
        <button disabled={!p.eval_tasks} onClick={() => void run("eval", "Eval")}>
          Run eval
        </button>
        <button onClick={() => void run("check", "Checks")}>Run checks</button>
        <button className="quiet" onClick={() => void detect()}>
          Detect languages
        </button>
      </div>
    </section>
  );
}
