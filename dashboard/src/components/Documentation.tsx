import { useState, type ReactNode } from "react";
import type { DocPackInfo } from "../api";

export function Documentation({ packs, selected, onSelect, actions }: { packs: DocPackInfo[]; selected?: string[]; onSelect?: (ids: string[]) => void; actions?: (d:DocPackInfo) => ReactNode }) {
  const [query,setQuery] = useState("");
  const visible = packs.filter(d => `${d.name} ${d.version} ${d.notes}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="stack-s">
    <label className="field"><span>Search documentation</span><input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
    <p className="small muted">How this is used: selected reference passages are added to this project's search index and retrieved as context the model can cite. Selection alone never downloads or indexes documentation.</p>
    {!visible.length && <p role="status">No documentation matches your search.</p>}
    {[true,false].map(downloaded => <section key={String(downloaded)} aria-label={downloaded ? "Downloaded documentation" : "Available documentation"}>
      <h3>{downloaded ? "Downloaded on this instance" : "Available to add"}</h3>
      <div className="doc-grid">{visible.filter(d => d.status.fetched === downloaded).map(d => <article className="panel stack-s" key={d.id}>
        <h4>{d.name} <span className="muted">{d.version}</span></h4>
        <p className="small">{d.notes || `Versioned reference material for ${d.name}.`}</p>
        <p className="small">License: {d.license}. {d.status.fetched ? `Downloaded · ${d.status.files} prepared files; indexed after a build.` : "Not downloaded."}</p>
        {d.homepage && <a href={d.homepage} target="_blank" rel="noreferrer">Source / homepage</a>}
        <p className="small muted">{d.sources.length ? "Download from Library, or add a local copy." : d.local_command ? "Can be collected from installed local documentation, or added from a local copy." : "Add a local file or folder from Library after downloading it yourself."}</p>
        {onSelect && <label className="row"><input type="checkbox" checked={selected?.includes(d.id) ?? false} onChange={e => onSelect(e.target.checked ? [...selected ?? [],d.id] : (selected ?? []).filter(id => id !== d.id))} />Use {d.name} for this project</label>}
        {actions?.(d)}
      </article>)}</div>
    </section>)}
  </div>;
}
