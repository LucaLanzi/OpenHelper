import { useEffect, useState } from "react";
import { get, post, setToken, type JobSummary, type LinksInfo, type DocPackInfo, type LanguageInfo } from "../api";
import { Documentation } from "../components/Documentation";
import { PathField } from "../components/PathField";
import { Diff, Empty, ErrorNote, PageHead, useLoad, useToast } from "../components/ui";
import { go, href } from "../router";

// ------------------------------------------------------------------------ Links

export function Links() {
  const toast = useToast();
  const links = useLoad(() => get<LinksInfo>("/links"));
  const l = links.data;
  const platforms = [...new Set(l?.matrix.flatMap((m) => [m.from, m.to]) ?? [])];

  const kill = async (on: boolean) => {
    try {
      const r = await post<{ applied: boolean; error?: string }>("/kill-switch", { on });
      toast(r.applied ? (on ? "Kill switch on: platforms can't hand work to each other" : "Kill switch off") : `Not changed: ${r.error}`);
      links.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <>
      <PageHead title="Links" intro="Which platform may hand work to which. Platforms are isolated until you add a link. The dashboard can always see and configure every platform.">
        <button className={l?.kill_switch ? "primary" : "danger"} onClick={() => void kill(!l?.kill_switch)}>
          {l?.kill_switch ? "Turn kill switch off" : "Turn kill switch on"}
        </button>
      </PageHead>
      <ErrorNote error={links.error} />
      {platforms.length < 2 ? (
        <Empty title="One platform so far">Add a second machine's platform file to link them.</Empty>
      ) : (
        <div className="panel table-wrap">
          <table>
            <caption className="small muted" style={{ textAlign: "left", paddingBottom: 8 }}>
              Rows send, columns receive.
            </caption>
            <thead>
              <tr>
                <th scope="col">From \ To</th>
                {platforms.map((p) => (
                  <th key={p} scope="col">
                    {p}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {platforms.map((a) => (
                <tr key={a}>
                  <th scope="row">{a}</th>
                  {platforms.map((b) => {
                    if (a === b) return <td key={b} className="muted">—</td>;
                    const m = l?.matrix.find((x) => x.from === a && x.to === b);
                    return (
                      <td key={b} title={m?.reason}>
                        {m?.allowed ? <strong>Allowed</strong> : <span className="muted">Blocked</span>}
                        <div className="small muted">{m?.reason}</div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {l?.links.length ? (
        <div className="section">
          <h2>Budgets</h2>
          <div className="panel table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Link</th>
                  <th>Mode</th>
                  <th>Hops</th>
                  <th>Tokens</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {l.links.map((x, i) => (
                  <tr key={i}>
                    <td>
                      {x.from} to {x.to}
                    </td>
                    <td>{x.mode}</td>
                    <td>{x.budget.max_hops}</td>
                    <td>{x.budget.max_tokens.toLocaleString()}</td>
                    <td>{x.budget.max_wall_min} min</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      <p className="muted" style={{ marginTop: 16 }}>
        Change links in <a href={href("settings", "links.toml")}>Settings</a>; you'll see the exact change before it applies.
      </p>
    </>
  );
}

// ------------------------------------------------------------------------ Library

function Languages() {
  const toast = useToast();
  const languages = useLoad(() => get<LanguageInfo[]>("/languages"));
  const [name, setName] = useState("");
  const [extensions, setExtensions] = useState("");
  const [test, setTest] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    try {
      await post("/languages", { name, extensions, test });
      toast(`Added ${name}. Press Detect languages on your project.`);
      setName("");
      setExtensions("");
      setTest("");
      languages.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="section stack-s" aria-label="Languages">
      <h2>Languages</h2>
      <p className="muted">A language pack detects source files and defines code checks. Documentation packs provide reference text for search.</p>
      <ErrorNote error={languages.error}/>
      <div className="doc-grid">{languages.data?.map(l=><details className="panel" key={l.id}><summary>{l.name} · {l.details.length} checks</summary><p>Detects: {l.detect.join(", ")}</p><p>Checks run {l.sandbox === "none" ? "directly on this machine when manually requested; auto-run is disabled" : `inside ${l.sandbox} with network disabled`}. A project's execution platform chooses its sandbox.</p><ul>{l.details.map(c=><li key={c.id}><strong>{c.name}</strong> ({c.kind}) · requires {c.requires.join(", ") || "no additional tools"}{c.when_files.length ? `; applies when ${c.when_files.join(", ")} exists` : ""}</li>)}</ul><p>Missing tools cause checks to be skipped and prevent a fully Checked result. Exit code 77 means a check does not apply.</p><p className="small">Example: add a repository containing {l.detect[0]}, enable {l.name} during setup, then choose Run checks in its project panel.</p></details>)}</div>
      <div className="panel stack-s">
        <h3>Add a language</h3>
        <div className="row">
          <label className="field">
            <span>Name</span>
            <input value={name} placeholder="Rust" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>File extensions</span>
            <input value={extensions} placeholder="rs" onChange={(e) => setExtensions(e.target.value)} />
          </label>
          <label className="field" style={{ flex: 1, minWidth: 200 }}>
            <span>Test command (optional)</span>
            <input value={test} placeholder="cargo test --offline" onChange={(e) => setTest(e.target.value)} />
          </label>
        </div>
        <p className="small muted">Checks use the execution platform’s sandbox. With no sandbox, manually requested checks run directly on the host. Missing tools are skipped.</p>
        <ErrorNote error={error} />
        <div>
          <button className="primary" disabled={!name.trim() || !extensions.trim()} onClick={() => void add()}>
            Add language
          </button>
        </div>
      </div>
    </section>
  );
}

function AddLocalDocs({ id, homepage }: { id: string; homepage: string }) {
  const toast = useToast();
  const [path, setPath] = useState("");
  const add = async () => {
    try {
      const j = await post<JobSummary>(`/docs/${id}/local`, { path });
      toast(`Adding ${id}`);
      go("jobs", j.id);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div className="stack-s" style={{ minWidth: 240 }}>
      <span className="small">
        Download from <a href={homepage}>{homepage.replace(/^https?:\/\//, "")}</a>, then add it here.
      </span>
      <PathField label="File or folder" kind="file" value={path} onChange={setPath} placeholder="~/Downloads/docs.zip" />
      <div>
        <button onClick={() => void add()} disabled={!path.trim()}>
          Add docs
        </button>
      </div>
    </div>
  );
}

export function Library() {
  const toast = useToast();
  const docs = useLoad(() => get<DocPackInfo[]>("/docs"));
  const fetchPack = async (id: string) => {
    try {
      const j = await post<JobSummary>("/jobs", { type: "docs", project: "", input: { pack: id }, start: true });
      toast(`Fetching ${id}`);
      go("jobs", j.id);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <>
      <PageHead title="Library" intro="Version-pinned docs the model cites. Each is downloaded to this machine once, then used offline. Rebuild a project's index after fetching." />
      <ErrorNote error={docs.error} />
      <p className="notice">Documentation packs are versioned reference material shared by projects on this instance. Language packs detect code and run checks. Download a pack or add a local file/folder below, select it during project setup, then explicitly build the project's index. Adding or refreshing documentation requires an index rebuild; remote instances keep their own copies.</p>
      <Documentation packs={docs.data ?? []} actions={d=><div className="stack-s">{Boolean(d.sources.length || d.local_command) && <button onClick={()=>void fetchPack(d.id)}>{d.status.fetched ? "Download again" : "Download / collect documentation"}</button>}<details><summary>Add a local copy</summary><AddLocalDocs id={d.id} homepage={d.homepage}/></details></div>}/>
      <Languages />
    </>
  );
}

// ------------------------------------------------------------------------ Audit

interface AuditEvent {
  ts: string;
  actor: string;
  action: string;
  platform?: string;
  detail?: Record<string, unknown>;
}

export function Audit() {
  const events = useLoad(() => get<AuditEvent[]>("/audit?limit=300"));
  const verify = useLoad(() => get<{ first_broken: number }>("/audit/verify"));
  return (
    <>
      <PageHead title="Audit log" intro="Everything that started, changed or crossed between platforms. Each entry is chained to the one before, so edits to history show up." />
      {verify.data && (
        <div className={`notice ${verify.data.first_broken === -1 ? "ok" : "error"}`} style={{ marginBottom: 16 }}>
          {verify.data.first_broken === -1 ? "The log is intact." : `The log was changed at entry ${verify.data.first_broken}.`}
        </div>
      )}
      <ErrorNote error={events.error} />
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {events.data?.map((e, i) => (
              <tr key={i}>
                <td className="small">{new Date(e.ts).toLocaleString()}</td>
                <td>{e.actor}</td>
                <td>
                  {e.action}
                  {e.platform && <div className="small muted">{e.platform}</div>}
                </td>
                <td className="small mono" style={{ wordBreak: "break-word" }}>
                  {e.detail ? JSON.stringify(e.detail) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ------------------------------------------------------------------------ Settings

interface Staged {
  file: string;
  diff: string;
  valid: boolean;
  error?: string;
}

export function Settings({ file }: { file?: string }) {
  const toast = useToast();
  const files = useLoad(() => get<string[]>("/config/files"));
  const hist = useLoad(() => get<{ stamp: string; files: string[] }[]>("/config/history"));
  const current = file ?? "config.toml";
  const content = useLoad(() => get<{ content: string }>(`/config?file=${encodeURIComponent(current)}`), [current]);
  const [text, setText] = useState("");
  const [staged, setStaged] = useState<Staged | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(content.data?.content ?? "");
    setStaged(null);
  }, [content.data]);

  const review = async () => {
    setError(null);
    try {
      setStaged(await post<Staged>("/config/stage", { file: current, content: text }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const apply = async () => {
    try {
      const r = await post<{ applied: boolean; rolled_back: boolean; error?: string }>("/config/apply", { file: current });
      if (r.applied) toast(`Applied ${current}`);
      else setError(`Rolled back: ${r.error}`);
      setStaged(null);
      content.reload();
      hist.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const restore = async (stamp: string, f: string) => {
    await post("/config/restore", { stamp, file: f });
    toast(`Restored ${f} from ${stamp}`);
    content.reload();
  };

  return (
    <>
      <PageHead title="Settings" intro="Platform, link, project and workflow files for this workspace. You see the exact change before it applies, and a change that breaks anything rolls back.">
        <button
          onClick={() => {
            setToken("");
            window.location.reload();
          }}
        >
          Sign out
        </button>
      </PageHead>
      <div className="row" style={{ alignItems: "flex-end", marginBottom: 12 }}>
        <label className="field" style={{ minWidth: 260 }}>
          <span>File</span>
          <select value={current} onChange={(e) => go("settings", e.target.value)}>
            {(files.data ?? [current]).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      </div>
      <textarea className="code" value={text} onChange={(e) => { setText(e.target.value); setStaged(null); }} aria-label={current} spellCheck={false} />
      <ErrorNote error={error} />
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={() => void review()} disabled={text === content.data?.content}>
          Review changes
        </button>
      </div>
      {staged && (
        <div className="panel stack" style={{ marginTop: 16 }}>
          <h2>Change to {staged.file}</h2>
          {staged.valid ? null : <div className="notice error">This would not load: {staged.error}</div>}
          <Diff text={staged.diff} />
          <div className="row">
            <button className="primary" disabled={!staged.valid} onClick={() => void apply()}>
              Apply change
            </button>
            <button onClick={() => setStaged(null)}>Keep editing</button>
          </div>
        </div>
      )}
      <div className="section">
        <h2>Earlier versions</h2>
        {hist.data?.length ? (
          <ul className="list panel">
            {hist.data.map((h) => (
              <li key={h.stamp} className="row between">
                <span>
                  {h.stamp.replace(/T(\d\d)-(\d\d)-(\d\d).*/, " $1:$2")} <span className="small muted">{h.files.join(", ")}</span>
                </span>
                <span className="row">
                  {h.files.map((f) => (
                    <button key={f} className="quiet" onClick={() => void restore(h.stamp, f)}>
                      Restore {f}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No earlier versions yet. Each applied change keeps a copy of the file before it.</p>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------------ Login

export function Login({ onDone }: { onDone: () => void }) {
  const [t, setT] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setToken(t.trim());
    try {
      await get("/status");
      onDone();
    } catch {
      setToken("");
      setError("That token wasn't accepted. Get it from the System page on this machine, or run ./openhelper token.");
    }
  };
  return (
    <div className="login">
      <form
        className="panel stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1>OpenHelper</h1>
        <p className="muted">Paste this machine's API token. On the machine, run <code>./openhelper open</code> to sign in without one, or <code>./openhelper token</code> to print it. It stays in this browser only.</p>
        <label className="field">
          <span>API token</span>
          <input type="password" autoComplete="current-password" value={t} onChange={(e) => setT(e.target.value)} autoFocus />
        </label>
        <ErrorNote error={error} />
        <button className="primary" type="submit" disabled={!t.trim()}>
          Sign in
        </button>
      </form>
    </div>
  );
}

export function NotFound() {
  return <Empty title="Nothing here">That page doesn't exist. Go to <a href={href("platforms")}>Platforms</a>.</Empty>;
}

