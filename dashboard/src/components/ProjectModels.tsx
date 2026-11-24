import { useState } from "react";
import { get, post, put, type ModelInfo, type PlatformInfo, type Project } from "../api";
import { PathField } from "./PathField";
import { ErrorNote, useLoad, useToast } from "./ui";

type Settings = Pick<Project, "model" | "light_model" | "search" | "embed_model">;

/** Change a saved project's models and search mode, and move its embeddings between machines. */
export function ProjectModels({ project: p, onSaved, onRebuild }: { project: Project; onSaved: () => void; onRebuild: () => void }) {
  const toast = useToast();
  const options = useLoad(() => get<{ platforms: PlatformInfo[]; models: ModelInfo[]; self: string }>("/project-options"));
  const [draft, setDraft] = useState<Settings>({ model: p.model, light_model: p.light_model, search: p.search, embed_model: p.embed_model });
  const [importPath, setImportPath] = useState("");
  const [exported, setExported] = useState<{ path: string; count: number; model: string; bytes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const target = options.data?.platforms.find((x) => x.name === (p.platform || options.data?.self));
  const all = options.data?.models ?? [];
  const models = all.filter((m) => !m.roles.includes("embed") && (!target?.model.allowed.length || target.model.allowed.includes(m.id) || [target.model.current, target.model.light].includes(m.id)));
  const embedders = all.filter((m) => m.roles.includes("embed"));
  const wanted = draft.search === "keyword" ? "" : draft.embed_model || target?.model.embed || "";
  const changed = (Object.keys(draft) as (keyof Settings)[]).some((k) => draft[k] !== p[k]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const save = () => act(async () => {
    await put(`/projects/${p.name}/settings`, draft);
    toast(p.index && (p.index.embed_model ?? "") !== wanted ? "Saved. Rebuild the index to use the new embedding choice." : "Saved");
    onSaved();
  });
  const exportNow = () => act(async () => setExported(await post(`/projects/${p.name}/embeddings/export`)));
  const importNow = () => act(async () => {
    const r = await post<{ project: string; model: string; added: number; already: number }>("/embeddings/import", { path: importPath });
    toast(`Added ${r.added.toLocaleString()} ${r.model} embeddings from ${r.project} (${r.already.toLocaleString()} already here)`);
    if (wanted && r.model !== wanted) setError(`This file holds ${r.model} embeddings, but this project uses ${wanted}. Choose ${r.model} above, save, then rebuild.`);
    else onRebuild();
  });

  return (
    <div className="stack-s" aria-label={`Models and search for ${p.name}`}>
      <h3>Models and search</h3>
      <ErrorNote error={error || options.error} />
      {(["model", "light_model"] as const).map((k) => (
        <label className="field" key={k}>
          <span>{k === "model" ? "Project model" : "Light / fast model"}</span>
          <select value={draft[k]} onChange={(e) => set(k, e.target.value)}>
            <option value="">{k === "model" ? "Platform default" : "Platform light model"}</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      ))}
      <label className="field">
        <span>Search mode</span>
        <select value={draft.search} onChange={(e) => set("search", e.target.value)}>
          <option value="platform-default">Platform default</option>
          <option value="keyword">Keyword only · no embedding model needed</option>
          <option value="hybrid">Hybrid · keywords plus embeddings</option>
        </select>
      </label>
      {draft.search !== "keyword" && (
        <label className="field">
          <span>Embedding model</span>
          <select value={draft.embed_model} onChange={(e) => set("embed_model", e.target.value)}>
            <option value="">Platform embedding model{target?.model.embed ? ` (${target.model.embed})` : ""}</option>
            {embedders.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      )}
      <div className="row">
        <button className="primary" disabled={busy || !changed} onClick={() => void save()}>Save models and search</button>
      </div>

      <h3>Move embeddings to another machine</h3>
      <p className="small">Embed on the machine with the faster GPU, export, copy the file over (for example with scp), import it here, then rebuild. The rebuild embeds only what changed since the export. Both machines need the same embedding model.</p>
      <div className="row">
        <button disabled={busy || !p.index?.dims} onClick={() => void exportNow()}>Export embeddings</button>
        {!p.index?.dims && <span className="small muted">The index has no embeddings to export yet.</span>}
      </div>
      {exported && (
        <p className="small" role="status">
          Wrote {exported.count.toLocaleString()} {exported.model} embeddings ({(exported.bytes / 1e6).toFixed(1)} MB) to <code>{exported.path}</code>. Copy it with <code>scp {exported.path} other-machine:</code>
        </p>
      )}
      <PathField label="Embeddings file to import (.ohemb.gz)" kind="file" value={importPath} onChange={setImportPath} placeholder="~/demo-embeddings-2026-11-24.ohemb.gz" />
      <div className="row">
        <button disabled={busy || !importPath.trim()} onClick={() => void importNow()}>Import embeddings</button>
      </div>
    </div>
  );
}
