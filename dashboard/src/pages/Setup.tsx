import { useEffect, useState, type ReactNode } from "react";
import { get, post, type Job, type JobSummary } from "../api";
import { ErrorNote, PageHead, useLoad } from "../components/ui";
import { go, href } from "../router";

interface SetupStatus {
  starter: { id: string; name: string; size_gb: number; license: string; present: boolean }[];
  model_ready: boolean;
  sandbox: string;
  sandbox_ready: boolean;
  projects: number;
  indexed: number;
  done: boolean;
}

export function Setup() {
  const status = useLoad(() => get<SetupStatus>("/setup"));
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A download can outlast the page, so pick a running one back up.
  useEffect(() => {
    void get<JobSummary[]>("/jobs").then((jobs) => {
      const active = jobs.find((j) => j.type.startsWith("setup-") && (j.status === "running" || j.status === "queued"));
      if (active) setJobId(active.id);
    });
  }, []);

  useEffect(() => {
    if (!jobId) return;
    const t = setInterval(() => {
      void get<Job>(`/jobs/${jobId}`).then((j) => {
        setJob(j);
        if (j.status === "running" || j.status === "queued") return;
        setJobId(null);
        setJob(null);
        if (j.status === "failed") setError(j.error ?? "That step failed. See the Jobs page for the log.");
        status.reload();
      });
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const start = async (path: string) => {
    setError(null);
    try {
      setJobId((await post<JobSummary>(path)).id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const s = status.data;
  const busy = Boolean(jobId);
  const toDownload = s?.starter.filter((m) => !m.present) ?? [];
  const size = toDownload.reduce((sum, m) => sum + m.size_gb, 0);
  // Job log lines start with a time; curl's progress lines then start with the percentage.
  const percent = job && /^\d\d:\d\d:\d\d\s+(\d+)\s+[\d.]+[kKMGT]?\s/.exec(job.log[job.log.length - 1] ?? "")?.[1];
  const progress = job && (
    <div className="stack-s">
      <p className="small muted" role="status">
        {job.type === "setup-sandbox"
          ? "Setting up the VM. This takes a few minutes."
          : percent === "100"
            ? "Checking the download…"
            : percent
              ? `Downloading… ${percent}%`
              : "Starting the download…"}{" "}
        <a href={href("jobs", job.id)}>Details</a>
      </p>
      <div>
        <button className="quiet" onClick={() => void post(`/jobs/${job.id}/cancel`)}>
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <>
      <PageHead title="Setup" intro="Three steps, then OpenHelper is ready to use." />
      <ErrorNote error={status.error ?? error} />
      {s && (
        <div className="stack">
          <Step n={1} title="Download the model" done={s.model_ready}>
            <ul className="small">
              {s.starter.map((m) => (
                <li key={m.id}>
                  {m.name}, {m.size_gb} GB, {m.license}
                  {m.present ? " (downloaded)" : ""}
                </li>
              ))}
            </ul>
            {!s.model_ready &&
              (job?.type === "setup-model" ? (
                progress
              ) : (
                <div>
                  <button className="primary" disabled={busy} onClick={() => void start("/setup/model")}>
                    {toDownload.length ? `Download ${size.toFixed(1)} GB` : "Use these models"}
                  </button>
                </div>
              ))}
          </Step>

          <Step n={2} title="Set up the sandbox" done={s.sandbox_ready}>
            <p className="small muted">Generated code runs here, isolated from your files and with no network. It uses about 7 GB of disk and takes a few minutes.</p>
            {!s.sandbox_ready &&
              (job?.type === "setup-sandbox" ? (
                progress
              ) : (
                <div>
                  <button className="primary" disabled={busy} onClick={() => void start("/setup/sandbox")}>
                    Set up sandbox
                  </button>
                </div>
              ))}
          </Step>

          <Step n={3} title="Add a repo" done={s.indexed > 0}>
            {s.indexed > 0 ? (
              <p className="small muted">
                {s.indexed} {s.indexed === 1 ? "repo" : "repos"} ready. <a href={href("projects")}>Add another</a>.
              </p>
            ) : s.projects > 0 ? (
              <p className="small muted">
                Your repo isn't searchable yet. Build its index on the <a href={href("projects")}>Projects</a> page.
              </p>
            ) : (
              <div>
                <button className="primary" onClick={() => go("projects")}>
                  Choose a repo
                </button>
              </div>
            )}
          </Step>

          {s.done && (
            <section className="panel stack-s">
              <h2>You're ready</h2>
              <p>
                <a href={href("ask")}>Ask about your code</a>, or <a href={href("workflows")}>make a change</a>.
              </p>
            </section>
          )}
        </div>
      )}
    </>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <section className="panel stack-s" aria-label={title}>
      <div className="row between">
        <h2>
          {n}. {title}
        </h2>
        {done && <span className="state done">Done</span>}
      </div>
      {children}
    </section>
  );
}
