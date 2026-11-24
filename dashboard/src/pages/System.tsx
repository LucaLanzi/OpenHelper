import { useState } from "react";
import { get, getToken, post, type JobSummary } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorNote, PageHead, useLoad, useToast } from "../components/ui";
import { go } from "../router";

interface SystemInfo {
  version: string;
  commit: string;
  branch: string;
  log: string;
}

export function System() {
  const toast = useToast();
  const info = useLoad(() => get<SystemInfo>("/system"));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: "restart" | "update", word: string) => {
    setError(null);
    setBusy(word);
    try {
      await post(`/system/${action}`);
      // The engine goes away during a restart, so wait for it to answer again.
      await new Promise((r) => setTimeout(r, 2500));
      for (let i = 0; i < 240; i++) {
        const up = await fetch("/api/health").then((r) => r.ok, () => false);
        if (up) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      toast(`${word} finished`);
      info.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const rebuildSandbox = async () => {
    setError(null);
    try {
      go("jobs", (await post<JobSummary>("/setup/sandbox")).id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(getToken());
      toast("Sign-in token copied");
    } catch {
      setError("Your browser blocked copying the token.");
    }
  };

  const [askOff, setAskOff] = useState(false);
  const [off, setOff] = useState(false);
  const turnOff = async () => {
    setError(null);
    setBusy("Off");
    try {
      await post("/system/off");
      setOff(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      setAskOff(false);
    }
  };

  if (off)
    return (
      <section className="panel stack-s" role="status">
        <h2>OpenHelper is off</h2>
        <p>The sandbox VM, model server and engine have stopped. To turn it back on, run this on this machine:</p>
        <pre>./openhelper start</pre>
        <p className="small muted">It also starts again the next time you log in.</p>
      </section>
    );

  const i = info.data;
  return (
    <>
      <PageHead title="System" intro="Keep OpenHelper up to date and restart it on this machine." />
      <ErrorNote error={info.error ?? error} />
      <section className="panel stack-s" aria-label="This install">
        <h2>OpenHelper {i?.version}</h2>
        <p className="small muted">{i ? `${i.branch || "detached"} at ${i.commit}` : ""}</p>
        <div className="row">
          <button className="primary" disabled={Boolean(busy)} onClick={() => void run("update", "Update")}>
            {busy === "Update" ? "Updating…" : "Update"}
          </button>
          <button disabled={Boolean(busy)} onClick={() => void run("restart", "Restart")}>
            {busy === "Restart" ? "Restarting…" : "Restart"}
          </button>
          <button disabled={Boolean(busy)} onClick={() => void rebuildSandbox()}>
            Rebuild sandbox
          </button>
          <button className="danger" disabled={Boolean(busy)} onClick={() => setAskOff(true)}>
            Turn off OpenHelper
          </button>
        </div>
        <p className="small muted">
          To save battery, the sandbox VM stops by itself once no dashboard is open and no job has run for a while, and models unload on the same timer
          (<code>unload_after_min</code> in the platform file). Turn off stops everything now.
        </p>
        {askOff && (
          <ConfirmDialog title="Turn off OpenHelper?" label="Turn off" busy={busy === "Off"} onCancel={() => setAskOff(false)} onConfirm={() => void turnOff()}>
            <p>This stops the sandbox VM, the model server and the engine. This dashboard stops working until you run <code>./openhelper start</code> on this machine.</p>
          </ConfirmDialog>
        )}
        {i?.log && (
          <pre className="small" style={{ overflowX: "auto" }}>
            {i.log}
          </pre>
        )}
      </section>
      <section className="panel stack-s" style={{ marginTop: 16 }} aria-label="Other devices">
        <h2>Sign in on another device</h2>
        <p className="small muted">Paste this token on the other device. Treat it like a password.</p>
        <div>
          <button onClick={() => void copyToken()}>Copy sign-in token</button>
        </div>
      </section>
    </>
  );
}
