import { useState } from "react";
import { get, post } from "../api";
import { useLoad, useToast } from "./ui";

/** A path on this machine: typed, or picked with the native chooser on macOS. */
export function PathField({ label, kind, value, onChange, placeholder }: { label: string; kind: "file" | "folder"; value: string; onChange: (v: string) => void; placeholder: string }) {
  const toast = useToast();
  const host = useLoad(() => get<{ local: boolean; picker: boolean }>("/host"));
  const [busy, setBusy] = useState(false);

  const choose = async () => {
    setBusy(true);
    try {
      const r = await post<{ path: string | null }>("/pick", { kind });
      if (r.path) onChange(r.path);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (host.data && !host.data.local) return <p className="small muted">Open the dashboard on this machine to add files.</p>;
  return (
    <label className="field">
      <span>{label}</span>
      <div className="row">
        <input style={{ flex: 1, minWidth: 0 }} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        {host.data?.picker && (
          <button type="button" onClick={() => void choose()} disabled={busy}>
            {busy ? "Waiting…" : `Choose ${kind}…`}
          </button>
        )}
      </div>
    </label>
  );
}
