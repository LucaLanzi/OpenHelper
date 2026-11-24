import { useEffect, useState } from "react";
import { get, nodePath, post, type LinksInfo, type ModelInfo, type PlatformInfo } from "../api";
import { ErrorNote, PageHead, useLoad, useToast } from "../components/ui";
import { useApp } from "../context";
import { PlatformActions, PlatformEditor, TailscaleOnboarding, blankPlatform } from "../components/PlatformEditor";
import { href } from "../router";

export function Platforms() {
  const { self } = useApp();
  const platforms = useLoad(() => get<PlatformInfo[]>("/platforms"));
  const links = useLoad(() => get<LinksInfo>("/links"));

  useEffect(() => {
    const t = window.setInterval(() => platforms.reload(), 10_000);
    return () => window.clearInterval(t);
  }, [platforms.reload]);

  const [editing,setEditing]=useState<PlatformInfo | null | undefined>(undefined);
  const ps = platforms.data ?? [];
  return (
    <>
      <PageHead
        title="Platforms"
        intro="Each machine runs its own model. They only hand work to each other where a link allows it."
      />
      <ErrorNote error={platforms.error ?? links.error} />
      <div className="stack" style={{marginBottom:20}}>
      <TailscaleOnboarding onAdd={(url,host)=>setEditing({...blankPlatform(),url,connection:"tailscale",tailscale_hostname:host})}/>
      {editing !== undefined ? <PlatformEditor key={editing?.name || "new"} platform={editing?.name ? editing : undefined} initial={editing ?? undefined} onCancel={()=>setEditing(undefined)} onSaved={()=>{setEditing(undefined);platforms.reload();}}/> : <button className="primary" onClick={()=>setEditing(null)}>Add platform</button>}
      <p className="small">Links permit direction and set hop, token, and time budgets. The kill switch stops cross-platform agent messages. Dashboard health and administrative controls remain available. Each platform must also allow the agent role and hook. Changes are recorded in the Audit log.</p>
      </div>
      <div className="line" aria-label="Machines and the links between them">
        {ps.map((p, i) => (
          <MachineAndWire key={p.name} p={p} next={ps[i + 1]} links={links.data} self={self} onChange={platforms.reload} onEdit={()=>setEditing(p)} />
        ))}
      </div>
      {links.data?.kill_switch && (
        <div className="notice error" role="alert">
          The kill switch is on: no platform can hand work to another. Turn it off on the <a href={href("links")}>Links</a> page.
        </div>
      )}
    </>
  );
}

function MachineAndWire({ p, next, links, self, onChange, onEdit }: { p: PlatformInfo; next?: PlatformInfo; links?: LinksInfo; self: string; onChange: () => void; onEdit:()=>void }) {
  return (
    <>
      <Machine p={p} self={self} onChange={onChange} onEdit={onEdit} />
      {next && <Wire a={p.name} b={next.name} links={links} />}
    </>
  );
}

function Wire({ a, b, links }: { a: string; b: string; links?: LinksInfo }) {
  const ab = links?.matrix.find((m) => m.from === a && m.to === b)?.allowed ?? false;
  const ba = links?.matrix.find((m) => m.from === b && m.to === a)?.allowed ?? false;
  const killed = links?.kill_switch ?? false;
  const cls = killed ? "killed" : ab || ba ? "on" : "off";
  const label = killed ? "Kill switch on" : ab && ba ? "Two-way link" : ab ? `${a} sends to ${b}` : ba ? `${b} sends to ${a}` : "Isolated";
  return (
    <div className={`wire ${cls}`} role="img" aria-label={label}>
      <svg viewBox="0 0 120 64" aria-hidden="true">
        <path d="M4 32 H116" strokeWidth="3" fill="none" />
        {!killed && ab && <path d="M104 24 L116 32 L104 40" strokeWidth="3" fill="none" />}
        {!killed && ba && <path d="M16 24 L4 32 L16 40" strokeWidth="3" fill="none" />}
        {killed && <path d="M52 18 L68 46" strokeWidth="3" fill="none" />}
        {!killed && !ab && !ba && <path d="M54 22 L66 42 M66 22 L54 42" strokeWidth="2" fill="none" style={{ strokeDasharray: "none" }} />}
      </svg>
      <span className="wire-label">{label}</span>
    </div>
  );
}

function SandboxPower() {
  const toast = useToast();
  const vm = useLoad(() => get<{ state: string }>("/sandbox"));
  const [busy, setBusy] = useState(false);
  const running = vm.data?.state === "Running";

  const toggle = async () => {
    setBusy(true);
    try {
      await post("/sandbox", { on: !running });
      toast(running ? "Sandbox VM stopped; it starts again when a job needs it" : "Sandbox VM started");
      vm.reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!vm.data) return <>Lima VM</>;
  if (vm.data.state === "missing") return <>Lima VM not set up</>;
  return (
    <span className="row">
      Lima VM {running ? "running" : "stopped"}
      <button className="quiet" onClick={() => void toggle()} disabled={busy}>
        {busy ? "Working…" : running ? "Stop" : "Start"}
      </button>
    </span>
  );
}

function Machine({ p, self, onChange, onEdit }: { p: PlatformInfo; self: string; onChange: () => void; onEdit:()=>void }) {
  const toast = useToast();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const s = p.status;

  useEffect(() => {
    if (!p.reachable) return;
    void get<{ current: string; models: ModelInfo[] }>(nodePath(p.name, self, "/models"))
      .then((m) => {
        setModels(m.models);
        setChoice(m.current);
      })
      .catch(() => {});
  }, [p.name, p.reachable, self]);

  const swap = async () => {
    setBusy(true);
    try {
      const r = await post<{ when: string }>(nodePath(p.name, self, "/models/swap"), { model: choice });
      toast(r.when === "now" ? `${p.name} now uses ${choice}` : `${p.name} will switch to ${choice} after the current job`);
      onChange();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pause = async (paused: boolean) => {
    try {
      await post(nodePath(p.name, self, "/queue"), { paused });
      toast(paused ? `Paused ${p.name}'s job queue` : `Resumed ${p.name}'s job queue`);
      onChange();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <section className={`machine${p.reachable ? "" : " offline"}`} aria-label={p.name}>
      <h3>
        {p.display_name || p.name}
        {p.self && <span className="state">This machine</span>}
      </h3>
      <p className="small muted">{p.description}</p>
      <PlatformActions p={p} onEdit={onEdit} onChange={onChange}/>
      {!p.reachable ? (
        <p style={{ marginTop: 12 }}>
          Can't reach {p.name}. It may be asleep, off, or off the tailnet. New requests fail visibly; check the remote job log for work already accepted. Nothing is re-routed.
        </p>
      ) : (
        <>
          <div className="model">{s?.model}</div>
          <dl>
            <dt>Model server</dt>
            <dd>{s?.llm_healthy ? (s.loaded.length ? `loaded ${s.loaded.join(", ")}` : "ready, nothing loaded") : "not responding"}</dd>
            <dt>Jobs</dt>
            <dd>
              {s?.queue.paused ? "paused" : s?.queue.running ? "running one" : "idle"}
              {s?.queue.queued ? `, ${s.queue.queued} queued` : ""}
            </dd>
            {s?.queue.pending_swap && (
              <>
                <dt>Next model</dt>
                <dd>{s.queue.pending_swap}, after the current job</dd>
              </>
            )}
            <dt>Sandbox</dt>
            <dd>{s?.sandbox === "none" ? "none (code is never run automatically)" : p.name === self && s?.sandbox === "lima" ? <SandboxPower /> : s?.sandbox}</dd>
          </dl>
          <hr />
          <div className="stack-s">
            <label className="field">
              <span>Model</span>
              <select value={choice} onChange={(e) => setChoice(e.target.value)}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} — {m.size_gb} GB{m.roles.includes("light") ? ", light" : ""}
                    {m.verified ? "" : ", not verified"}
                  </option>
                ))}
              </select>
            </label>
            <div className="row">
              <button className="primary" onClick={swap} disabled={busy || !choice || choice === s?.model}>
                Switch model
              </button>
              <button onClick={() => void pause(!s?.queue.paused)}>{s?.queue.paused ? "Resume jobs" : "Pause jobs"}</button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
