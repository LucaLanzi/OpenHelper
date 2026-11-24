import { z } from "zod";
import { embeddingModel, estimateIndex, workload } from "./index/estimate.js";
import { audit } from "./core/audit.js";
import { detectHardware } from "./core/detect.js";
import { canSend, withinBudget } from "./core/links.js";
import { findProject, loadLinks, loadPlatforms } from "./core/load.js";
import { validateProject } from "./project-management.js";
import { AgentHook, Project, type Platform } from "./core/schemas.js";
import type { Runtime } from "./runtime.js";
import type { Job, JobType } from "./jobs/queue.js";
import { PeerClient } from "./workflow/peers.js";

export const ProjectSettings = Project.pick({ languages:true, language_mode:true, checks:true, docs:true, model:true, light_model:true, search:true, embed_model:true, exclude:true });
export const HookRequest = z.object({
  operation: AgentHook,
  envelope: z.object({ from: z.string().regex(/^[a-z0-9_-]+$/), hops: z.number().int().min(1), tokens: z.number().int().nonnegative(), started_at: z.iso.datetime() }),
  input: z.record(z.string(), z.unknown()).default({}),
}).strict();
export function authorizeHook(from: string, target: Platform, operation: string, envelope: { hops: number; tokens: number; started_at: string }) {
  if (Date.parse(envelope.started_at) > Date.now()+60_000) throw Object.assign(new Error("Budget clock is in the future"),{statusCode:400});
  const link = canSend(loadLinks(), from, target.name);
  const budget = withinBudget(link.link, { ...envelope, started_at: Date.parse(envelope.started_at) });
  if (!link.allowed || !budget.allowed || !target.hooks.includes(operation as never)) {
    const reason = !link.allowed ? link.reason : !budget.allowed ? budget.reason : `Agent hook ${operation} is disabled on ${target.name}`;
    audit(from,"hook.refused",{operation,reason}, target.name);
    throw Object.assign(new Error(reason),{statusCode:403});
  }
}
export async function callHook<T>(from: string, target: Platform, operation: string, input: Record<string,unknown> = {}, started_at = new Date().toISOString()): Promise<T> {
  const envelope = { from, hops: 1, tokens: 0, started_at };
  authorizeHook(from,target,operation,envelope);
  audit(from,"hook.send",{operation},target.name);
  return new PeerClient(target).call<T>("POST","/api/hooks",{operation,envelope,input});
}
export function assertAgent(rt: Runtime, type: string) {
  const role: Record<string,string> = { explain:"explainer", plan:"planner", implement:"coder", review:"reviewer" };
  if (role[type] && !rt.platform.agents.includes(role[type] as never)) throw Object.assign(new Error(`${role[type]} is disabled on this platform`),{statusCode:403});
}
export async function executeHook(rt: Runtime, raw: unknown) {
  const b = HookRequest.parse(raw);
  if (!loadPlatforms().some(p => p.name === b.envelope.from)) throw Object.assign(new Error("Unknown sending platform"),{statusCode:403});
  authorizeHook(b.envelope.from,rt.platform,b.operation,b.envelope);
  audit(b.envelope.from,"hook.execute",{operation:b.operation},rt.platform.name);
  if (b.operation === "health") return rt.status();
  if (b.operation === "capabilities") return detectHardware();
  if (b.operation === "index-estimate") { const base=findProject(z.string().parse(b.input.project)); const p=b.input.settings ? validateProject({...base,...ProjectSettings.parse(b.input.settings)}) : base; return estimateIndex(rt.platform,workload(p),embeddingModel(p,rt.platform)); }
  if (b.operation === "models") return { models: rt.modelsOverview() };
  if (["job-status","job-logs","cancel-job"].includes(b.operation)) {
    const id = z.string().regex(/^[A-Za-z0-9_-]+$/).parse(b.input.id);
    const job = rt.queue.get(id);
    if (!job || job.origin?.from_platform !== b.envelope.from) throw Object.assign(new Error("No job owned by this sending platform"),{statusCode:404});
    if (b.operation === "cancel-job") return rt.queue.cancel(id,b.envelope.from);
    if (b.operation === "job-logs") return { log: job.log };
    return job;
  }
  const input = z.object({ project: z.string(), type: z.enum(["explain","plan","implement","review","check","index","mine","eval"]).optional(), model: z.string().default(""), input: z.object({task:z.string().optional(),plan:z.string().optional(),patch:z.string().optional(),checks:z.string().optional(),kinds:z.array(z.enum(["syntax","build","test","lint","static"])).optional(),best_of:z.number().int().min(1).max(8).optional(),limit:z.number().int().positive().optional(),light:z.boolean().optional()}).strict().default({}), settings:ProjectSettings.optional() }).strict().parse(b.input);
  const type: JobType = b.operation === "index" ? "index" : input.type ?? "explain";
  const base = findProject(input.project);
  const project = input.settings ? validateProject({...base,...input.settings}) : base;
  if (project.platform && project.platform !== rt.platform.name) throw new Error("Remote project must execute on this platform; recursive delegation is refused");
  assertAgent(rt,type);
  if (input.model && !rt.pickerModels().some(m => m.id === input.model)) throw new Error("Model is not offered on this platform");
  const job = rt.queue.create({ type, project: project.name, model: input.model, platform: rt.platform.name, input: input.input, project_config:project, origin: { from_platform:b.envelope.from } });
  rt.queue.start(job.id,b.envelope.from);
  return job;
}
export async function runRemote(rt: Runtime, job: Job, log: (s:string)=>void, signal: AbortSignal): Promise<Record<string,unknown>> {
  const target = loadPlatforms().find(p => p.name === job.platform);
  if (!target) throw new Error("Execution platform is no longer registered");
  // Require monitoring and cancellation before starting anything on another machine.
  const started = new Date().toISOString();
  for (const operation of ["job-status","cancel-job"]) authorizeHook(rt.platform.name,target,operation,{hops:1,tokens:0,started_at:started});
  const remote = await callHook<Job>(rt.platform.name,target,job.type === "index" ? "index" : "start-job",{ type:job.type, project:job.project, model:job.model, input:job.input, settings:ProjectSettings.parse(findProject(job.project)) },started);
  log(`Remote job ${remote.id} on ${target.display_name || target.name}. Repositories and documentation must already exist there; only the job request is sent.`);
  let seen = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await callHook<Job>(rt.platform.name,target,"job-status",{id:remote.id},started);
      for (const line of next.log.slice(seen)) log(line); seen = next.log.length;
      if (next.progress) rt.queue.updateProgress(job.id,next.progress);
      job.usage = next.usage;
      if (next.status === "done") return { ...next.output, remote_job:remote.id, remote_platform:target.name };
      if (["failed","canceled"].includes(next.status)) throw new Error(next.error || `Remote job ${next.status}`);
      await new Promise<void>(resolve => setTimeout(resolve,1000));
    }
  } catch (e) {
    try { await callHook(rt.platform.name,target,"cancel-job",{id:remote.id}); }
    catch { log(`Could not confirm cancellation. Check ${target.name} job ${remote.id} before removing the project. The remote job may still be running.`); }
    throw e;
  }
}
