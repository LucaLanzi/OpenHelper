import type { IndexEstimate as Estimate, IndexProgress } from "../api";
export function duration(seconds:number) { return seconds < 60 ? `${Math.ceil(seconds)} sec` : seconds < 3600 ? `${Math.ceil(seconds/60)} min` : `${Math.ceil(seconds/360)/10} hr`; }
export function IndexEstimate({ estimate }: {estimate:Estimate}) {
  return <aside className="notice" role="status" aria-label="Index time estimate"><strong>{duration(estimate.min_s)}–{duration(estimate.max_s)} on {estimate.platform}</strong><p>{estimate.basis} · {estimate.confidence} confidence</p><p className="small">{estimate.explanation}</p></aside>;
}
export function IndexProgressView({ progress:p }: {progress:IndexProgress}) {
  const done=p.phase==="complete";
  // Until embeddings have run a while, the ETA still leans on the estimate made before the build.
  const early=p.phase!=="embedding" && p.phase!=="saving";
  return <section className="panel stack-s" role="status" aria-label="Index progress"><h2>{p.phase[0]!.toUpperCase()+p.phase.slice(1)}</h2><p>{p.files_discovered} files discovered · {p.files_processed} files processed · {p.chunks} chunks{p.embeddings_completed ? ` · ${p.embeddings_completed} of ${p.chunks} embeddings` : ""}</p><p>Elapsed: {duration(p.elapsed_ms/1000)}{done ? "" : ` · About ${duration(p.eta_min_s)}–${duration(p.eta_max_s)} left${early ? " (initial estimate)" : ""}`}</p><a href="#job-log">Full job log</a></section>;
}
