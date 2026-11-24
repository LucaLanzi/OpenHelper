import { useState } from "react";
import { get, post, type JobSummary } from "../api";
import { ErrorNote, PageHead, useLoad, useToast } from "../components/ui";
import { go } from "../router";

interface ModelRow {
  id: string;
  name: string;
  kind: string;
  quant: string;
  size_gb: number;
  roles: string[];
  license: string;
  present: boolean;
  pinned: boolean;
  has_source: boolean;
  uses: string[];
  can_tune: boolean;
}

const USE_WORD: Record<string, string> = { main: "Main", light: "Light", embed: "Search" };

export function Models() {
  const models = useLoad(() => get<ModelRow[]>("/models/all"));
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <PageHead title="Models" intro="Download models and choose what each one does. Main does the work, Light answers quick questions, and Search finds passages in your code and docs." />
      <ErrorNote error={models.error ?? error} />
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Size</th>
              <th>Used for</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {models.data?.map((m) => <Row key={m.id} m={m} onChange={models.reload} onError={setError} />)}
          </tbody>
        </table>
      </div>
      <AddModel onAdded={models.reload} />
    </>
  );
}

function Row({ m, onChange, onError }: { m: ModelRow; onChange: () => void; onError: (e: string | null) => void }) {
  const toast = useToast();
  const [url, setUrl] = useState("");
  const job = async (action: string, payload: object = {}) => {
    onError(null);
    try {
      go("jobs", (await post<JobSummary>(`/models/${m.id}/${action}`, payload)).id);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const use = async (role: string) => {
    onError(null);
    try {
      await post(`/models/${m.id}/use`, { role });
      toast(`${m.name} is now the ${USE_WORD[role]!.toLowerCase()} model`);
      onChange();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const isEmbed = m.roles.includes("embed");
  return (
    <tr>
      <td>
        <strong>{m.name}</strong>
        <div className="small muted">
          {m.kind}, {m.quant}, {m.license}
        </div>
      </td>
      <td>{m.size_gb} GB</td>
      <td>{m.uses.length ? m.uses.map((u) => <span key={u} className="state done" style={{ marginRight: 4 }}>{USE_WORD[u]}</span>) : m.present ? "Not in use" : "Not downloaded"}</td>
      <td>
        {!m.present ? (
          <div className="stack-s" style={{ minWidth: 220 }}>
            {!m.has_source && <input aria-label={`Link to the GGUF file for ${m.name}`} placeholder="https://…/model.gguf" value={url} onChange={(e) => setUrl(e.target.value)} />}
            <div>
              <button disabled={!m.has_source && !url.trim()} onClick={() => void job("download", url.trim() ? { url: url.trim() } : {})}>
                Download {m.size_gb} GB
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            {isEmbed ? (
              !m.uses.includes("embed") && <button onClick={() => void use("embed")}>Use for search</button>
            ) : (
              <>
                {!m.uses.includes("main") && <button onClick={() => void use("main")}>Use as main</button>}
                {!m.uses.includes("light") && <button onClick={() => void use("light")}>Use as light</button>}
                <button className="quiet" onClick={() => void job("bench")}>
                  Benchmark
                </button>
                {m.can_tune && (
                  <button className="quiet" onClick={() => void job("tune")}>
                    Tune
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

function AddModel({ onAdded }: { onAdded: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [size, setSize] = useState("");
  const [role, setRole] = useState("main");
  const [license, setLicense] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    try {
      const r = await post<{ id: string }>("/models/add", { url: url.trim(), size_gb: Number(size), role, license });
      toast(`Added ${r.id}. Press Download to get it.`);
      setUrl("");
      setSize("");
      setLicense("");
      onAdded();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="panel stack-s" style={{ marginTop: 16 }} aria-label="Add a model">
      <h2>Add a model</h2>
      <p className="small muted">Paste a direct link to a GGUF file, for example from Hugging Face. Its hash is recorded on first download.</p>
      <label className="field">
        <span>Link to the .gguf file</span>
        <input value={url} placeholder="https://huggingface.co/owner/repo/resolve/main/model-Q4_K_M.gguf" onChange={(e) => setUrl(e.target.value)} />
      </label>
      <div className="row">
        <label className="field">
          <span>Size in GB</span>
          <input type="number" min="0.1" step="0.1" value={size} onChange={(e) => setSize(e.target.value)} />
        </label>
        <label className="field">
          <span>Used for</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="main">Main</option>
            <option value="light">Light</option>
            <option value="embed">Search</option>
          </select>
        </label>
        <label className="field">
          <span>License</span>
          <input value={license} placeholder="from the model card" onChange={(e) => setLicense(e.target.value)} />
        </label>
      </div>
      <ErrorNote error={error} />
      <div>
        <button className="primary" disabled={!url.trim() || !(Number(size) > 0)} onClick={() => void add()}>
          Add model
        </button>
      </div>
    </section>
  );
}
