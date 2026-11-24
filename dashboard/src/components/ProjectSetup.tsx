import { useRef, useState, useEffect } from "react";
import { get, post, type DocPackInfo, type IndexEstimate as Estimate, type LanguageInfo, type ModelInfo, type PlatformInfo, type Project } from "../api";
import { PathField } from "./PathField";
import { ErrorNote, useLoad, useToast } from "./ui";
import { Documentation } from "./Documentation";
import { IndexEstimate } from "./IndexEstimate";

type Draft = Omit<Project,"index"|"eval_tasks">;
const steps = ["Repository source","Languages and checks","Documentation","Models and platform","Indexing options","Review"];
export function ProjectSetup({ onAdded }: {onAdded:(name:string)=>void}) {
  const toast=useToast();
  const options=useLoad(()=>get<{platforms:PlatformInfo[];models:ModelInfo[];languages:LanguageInfo[];docs:DocPackInfo[];self:string}>("/project-options"));
  const [step,setStep]=useState(0), [busy,setBusy]=useState(false), [error,setError]=useState<string|null>(null);
  const [draft,setDraft]=useState<Draft>({name:"",description:"",repos:[""],languages:[],docs:[],model:"",light_model:"",platform:"",search:"keyword",embed_model:"",exclude:[],language_mode:"selected",checks:[]});
  const [detected,setDetected]=useState<string[]>([]), [build,setBuild]=useState(false), [estimate,setEstimate]=useState<Estimate|null>(null);
  const heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{ if(step) heading.current?.focus(); },[step]);
  const set=<K extends keyof Draft>(key:K,value:Draft[K])=>setDraft(d=>({...d,[key]:value}));
  const target=options.data?.platforms.find(p=>p.name===(draft.platform || options.data?.self));
  const models=(options.data?.models ?? []).filter(m=>!m.roles.includes("embed") && (!target?.model.allowed.length || target.model.allowed.includes(m.id) || [target.model.current,target.model.light].includes(m.id)));
  const next=async()=>{
    setBusy(true);setError(null);
    try {
      if(step===0){
        const p=await post<{repos:string[];languages:string[];docs:string[];name:string}>("/projects/preview",{repos:draft.repos,exclude:draft.exclude});
        setDetected(p.languages);
        setDraft(d=>({...d,...p,name:d.name || p.name,platform:d.platform || options.data?.self || "",model:d.model || target?.model.current || "",light_model:d.light_model || target?.model.light || "",embed_model:d.embed_model || target?.model.embed || "",checks:(options.data?.languages ?? []).filter(l=>p.languages.includes(l.id)).flatMap(l=>l.details.map(c=>`${l.id}/${c.id}`))}));
      }
      if(step===4) setEstimate(await post<Estimate>("/index/estimate",{project:draft}));
      setStep(s=>s+1);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  const confirm=async()=>{
    setBusy(true);setError(null);
    try {
      await post("/projects/configure",{project:draft,confirm:true});
      onAdded(draft.name);
      if(build){
        try {await post("/jobs",{type:"index",project:draft.name,start:true});toast(`Created ${draft.name}; index job started. Follow it in Jobs.`);}
        catch(e){toast(`Project saved. Index could not start: ${(e as Error).message}`);}
      } else toast(`Created ${draft.name}. Build its index when ready.`);
      setStep(0);setDraft({...draft,name:"",repos:[""]});setBuild(false);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  return <section className="panel stack" aria-label="Guided project setup">
    <h2 ref={heading} tabIndex={-1}>Set up a project · {steps[step]}</h2>
    <ol className="setup-steps">{steps.map((s,i)=><li key={s} aria-current={i===step ? "step" : undefined}>{i+1}. {s}</li>)}</ol>
    <ErrorNote error={error || options.error}/>
    {step===0 && <div className="stack-s"><p>Choose repositories accessible on this OpenHelper instance. Nothing is saved until the final confirmation.</p>{draft.repos.map((path,i)=><div className="row" key={i}><PathField label={`Repository ${i+1}`} kind="folder" value={path} onChange={v=>set("repos",draft.repos.map((r,n)=>n===i?v:r))} placeholder="~/code/my-project"/>{draft.repos.length>1 && <button aria-label={`Remove repository ${i+1}`} onClick={()=>set("repos",draft.repos.filter((_,n)=>n!==i))}>Remove path</button>}</div>)}<button onClick={()=>set("repos",[...draft.repos,""])}>Add another repository</button><label className="field"><span>Project ID (optional; lowercase letters, digits, - and _)</span><input value={draft.name} onChange={e=>set("name",e.target.value)}/></label><label className="field"><span>Description</span><input value={draft.description} onChange={e=>set("description",e.target.value)}/></label></div>}
    {step===1 && <div className="stack-s"><p>Detected: {detected.join(", ") || "No known languages"}. Enable the language packs and checks you want. Unselected checks will not run.</p>{options.data?.languages.map(l=><fieldset key={l.id}><legend><label><input type="checkbox" checked={draft.languages.includes(l.id)} onChange={e=>{set("languages",e.target.checked?[...draft.languages,l.id]:draft.languages.filter(id=>id!==l.id));set("checks",e.target.checked?[...draft.checks ?? [],...l.details.map(c=>`${l.id}/${c.id}`)]:(draft.checks ?? []).filter(id=>!id.startsWith(`${l.id}/`)));}}/> {l.name}</label></legend><p className="small muted">Detects {l.detect.join(", ")}</p>{draft.languages.includes(l.id) && l.details.map(c=><label className="row" key={c.id}><input type="checkbox" checked={draft.checks?.includes(`${l.id}/${c.id}`) ?? false} onChange={e=>set("checks",e.target.checked?[...draft.checks ?? [],`${l.id}/${c.id}`]:(draft.checks ?? []).filter(id=>id!==`${l.id}/${c.id}`))}/>{c.name} · requires {c.requires.join(", ") || "no additional binaries"}</label>)}</fieldset>)}</div>}
    {step===2 && <Documentation packs={options.data?.docs ?? []} selected={draft.docs} onSelect={v=>set("docs",v)}/>}
    {step===3 && <div className="stack-s"><label className="field"><span>Execution platform</span><select aria-label="Execution platform" value={draft.platform} onChange={e=>{const p=options.data?.platforms.find(p=>p.name===e.target.value)!;setDraft(d=>({...d,platform:p.name,model:p.model.current,light_model:p.model.light,embed_model:p.model.embed}));}}>{options.data?.platforms.map(p=><option key={p.name} value={p.name}>{p.display_name || p.name} · {p.os}</option>)}</select></label><p>{target?.description}</p>{draft.platform!==options.data?.self && <div className="notice">Remote execution sends the job prompt, project name, and chosen model. It does not copy repositories or documentation. Register the same project on that instance with paths valid there. Enable the required agent hooks and link on both instances. Offline requests fail visibly; work is never silently moved to another machine.</div>}{(["model","light_model"] as const).map(key=><label className="field" key={key}><span>{key==="model"?"Project model":"Light / fast model"}</span><select aria-label={key === "model" ? "Project model" : "Light / fast model"} value={draft[key]} onChange={e=>set(key,e.target.value)}><option value="">{key==="model"?"Platform default":"Platform light model"}</option>{models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>)}<p className="small">Models are configured as offered on this platform; verify that they are downloaded on the Models or Platforms page. Checks use its {target?.sandbox.driver || "configured"} sandbox; missing tools are skipped and cannot produce a fully Checked result.</p></div>}
    {step===4 && <div className="stack-s"><label className="field"><span>Search mode</span><select aria-label="Search mode" value={draft.search} onChange={e=>set("search",e.target.value)}><option value="keyword">Keyword only · no embedding model needed</option><option value="hybrid">Hybrid · keywords plus embeddings</option></select></label>{draft.search==="hybrid" && <label className="field"><span>Embedding model</span><select aria-label="Embedding model" value={draft.embed_model} onChange={e=>set("embed_model",e.target.value)}><option value="">Choose an embedding model</option>{options.data?.models.filter(m=>m.roles.includes("embed")).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}<label className="field"><span>Exclude paths (one glob per line)</span><textarea value={draft.exclude.join("\n")} onChange={e=>set("exclude",e.target.value.split("\n"))} placeholder="private/**&#10;generated/**"/></label><p className="small">Build folders, dependencies, binary files, and known secret files are excluded by default. Exclusions apply before the first index build.</p></div>}
    {step===5 && <div className="stack-s"><h3>Review {draft.name}</h3><dl><dt>Repository source</dt><dd>{draft.repos.join(", ")}</dd><dt>Languages and checks</dt><dd>{draft.languages.join(", ") || "None"} · {draft.checks?.length ?? 0} enabled checks</dd><dt>Documentation</dt><dd>{draft.docs.map(id=>{const d=options.data?.docs.find(d=>d.id===id);return `${d?.name || id} ${d?.version || ""} (${d?.status.fetched?"downloaded":"not downloaded"})`;}).join(", ") || "None"}</dd><dt>Models</dt><dd>{draft.model || "Platform default"} · light: {draft.light_model || "Platform light model"}</dd><dt>Platform</dt><dd>{target?.display_name || draft.platform}</dd><dt>Indexing</dt><dd>{draft.search}{draft.search==="hybrid"?` · ${draft.embed_model}`:""}</dd><dt>Exclusions</dt><dd>{draft.exclude.filter(Boolean).join(", ") || "Default exclusions only"}</dd></dl>{estimate && <IndexEstimate estimate={estimate}/>}<label className="row"><input type="checkbox" checked={build} onChange={e=>setBuild(e.target.checked)}/>Build the index after saving</label><p className="small">Only documentation already downloaded on the execution platform is indexed. Add missing documentation from Library, then rebuild. Shared downloads and source repositories remain separate from this project.</p></div>}
    <div className="row">{step>0 && <button disabled={busy} onClick={()=>{setError(null);setStep(s=>s-1);}}>Back</button>}{step<5 ? <button className="primary" disabled={busy || !options.data || (step===0 && draft.repos.some(p=>!p.trim()))} onClick={()=>void next()}>{busy?"Checking…":step===0?"Detect languages and continue":"Continue"}</button> : <button className="primary" disabled={busy} onClick={()=>void confirm()}>{busy?"Saving…":"Confirm and create project"}</button>}</div>
  </section>;
}
