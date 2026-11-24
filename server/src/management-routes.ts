import { existsSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "./core/audit.js";
import { detectHardware } from "./core/detect.js";
import { readJson, toToml, writeFileAtomic } from "./core/fsutil.js";
import { loadLinks, loadPlatforms, loadProjects, loadWorkflows } from "./core/load.js";
import { ws } from "./core/paths.js";
import { Project } from "./core/schemas.js";
import { resolvePlatform } from "./core/workflow-def.js";
import { callHook, executeHook, ProjectSettings } from "./hooks.js";
import { exportEmbeddings, importEmbeddings } from "./index/embed-cache.js";
import { embeddingModel, estimateIndex, workload } from "./index/estimate.js";
import { expandHome } from "./index/build.js";
import { previewProject, removalPaths, removeProjectFiles, saveProject, updateProject, validateProject } from "./project-management.js";
import { apiOrigin, tailscaleStatus, testSsh, validatePlatform } from "./platform-management.js";
import type { Runtime } from "./runtime.js";
import type { WorkflowEngine } from "./workflow/engine.js";
import { PeerClient } from "./workflow/peers.js";
const fail = (statusCode:number,message:string): never => { throw Object.assign(new Error(message),{statusCode}); };
/** From this machine: loopback, or one of its own addresses, as when bind is its Tailscale IP. req.ip is the socket peer (no trustProxy). */
export const isLocal = (r: FastifyRequest) => { const ip = r.ip.replace(/^::ffff:/,""); return ip === "127.0.0.1" || ip === "::1" || Object.values(networkInterfaces()).flat().some(i => i?.address === ip); };
const local = (r: FastifyRequest) => { if (!isLocal(r)) fail(403,"Open the dashboard on this machine to change its registry or local paths"); };
const idOf = (r: FastifyRequest) => z.string().regex(/^[a-z0-9_-]+$/).parse((r.params as {id:string}).id);
const client = <T>(fn:()=>T):T => { try {return fn();} catch(e) { return fail(400,(e as Error).message); } };
const active = (s:string) => ["running","waiting-approval"].includes(s);
const healthFile = (name:string) => join(ws.root(),"state","platform-health",`${name}.json`);
export const healthRecord = (name:string) => readJson<{last_success?:string}>(healthFile(name),{});
export function rememberHealth(name:string) { const state = {last_success:new Date().toISOString()}; writeFileAtomic(healthFile(name),JSON.stringify(state)); return state; }

export function managementRoutes(app: FastifyInstance, rt: Runtime, engine: WorkflowEngine) {
  const project = (id:string) => loadProjects().find(p => p.name === id) ?? fail(404,"No such project");
  const platform = (id:string) => loadPlatforms().find(p => p.name === id) ?? fail(404,"No such platform");
  app.post("/api/projects/preview", async req => {
    local(req);
    const b = z.object({repos:z.array(z.string()).min(1),exclude:z.array(z.string()).default([])}).parse(req.body);
    return client(()=>previewProject(b.repos,b.exclude));
  });
  app.post("/api/projects/configure", async req => {
    local(req);
    const b = z.object({project:Project,confirm:z.literal(true)}).parse(req.body);
    const p = client(()=>validateProject(b.project));
    client(()=>saveProject(p)); audit("user","project.add",{project:p.name,platform:p.platform});
    return {project:p};
  });
  // These two read no paths a request names, so the token is enough and they work from another device.
  app.put("/api/projects/:id/settings", async req => {
    const id = idOf(req); project(id);
    // Not Project.partial(): its defaults would blank every field the request leaves out.
    const b = z.object({model:z.string().optional(),light_model:z.string().optional(),search:Project.shape.search.unwrap().optional(),embed_model:z.string().optional()}).strict().parse(req.body);
    if (rt.queue.hasActive(id)) fail(409,"Wait for this project's running jobs to finish before changing its models");
    const p = client(()=>updateProject(id,b)); audit("user","project.settings",{project:id,...b});
    return {project:p};
  });
  app.post("/api/projects/:id/embeddings/export", async req => {
    const id = idOf(req); project(id);
    const file = join(ws.root(),"exports",`${id}-embeddings-${new Date().toISOString().slice(0,10)}.ohemb.gz`);
    const r = client(()=>exportEmbeddings(id,file)); audit("user","embeddings.export",{project:id,model:r.model,count:r.count});
    return {...r,path:file};
  });
  app.post("/api/embeddings/import", async req => {
    local(req);
    const path = expandHome(z.object({path:z.string().trim().min(1,"Choose an export file")}).parse(req.body).path);
    if (!existsSync(path)) fail(400,`${path} does not exist`);
    const r = client(()=>importEmbeddings(path)); audit("user","embeddings.import",{project:r.project,model:r.model,added:r.added});
    return r;
  });
  app.post("/api/index/estimate", async req => {
    local(req);
    const b = z.object({project:Project}).parse(req.body);
    const p = client(()=>validateProject(b.project));
    const target = platform(p.platform);
    // The workload is observed here; remote copies may differ and are never silently assumed equal.
    if (target.name !== rt.platform.name) {
      try { return await callHook(rt.platform.name,target,"index-estimate",{project:p.name,settings:ProjectSettings.parse(p)}); } catch { /* Unsaved remote project: clearly labeled local workload fallback below. */ }
    }
    const result = estimateIndex(target,workload(p),embeddingModel(p,target));
    if (target.name !== rt.platform.name) { result.confidence = "low"; result.explanation += " Workload measured from this machine; remote repository and documentation copies may differ. Register the same project on the remote instance before starting."; }
    return result;
  });
  app.get("/api/projects/:id/estimate", async req => {
    const p = project(idOf(req)); const target = platform(p.platform || rt.platform.name);
    if (target.name !== rt.platform.name) return callHook(rt.platform.name,target,"index-estimate",{project:p.name,settings:ProjectSettings.parse(p)});
    return estimateIndex(target,workload(p),embeddingModel(p,target));
  });
  const checkRemoval = async (id:string) => {
    const p = project(id);
    if (rt.queue.hasActive(id) || engine.all().some(r => r.project === id && active(r.status))) fail(409,"Finish or cancel this project's queued/running jobs and active workflows before removal");
    if (p.platform && p.platform !== rt.platform.name) {
      try {
        const s = await new PeerClient(platform(p.platform)).call<{active_projects?:string[]}>("GET","/api/status");
        if (!s.active_projects) fail(409,"Remote instance must be upgraded before its active jobs can be checked");
        if (s.active_projects?.includes(id)) fail(409,"A remote project job is still running; finish it before removal");
      } catch (e) { fail(409,`Cannot confirm remote project is idle: ${(e as Error).message}`); }
    }
    return p;
  };
  app.get("/api/projects/:id/removal", async req => {
    local(req); const p = await checkRemoval(idOf(req));
    return {remove:removalPaths(p).map(f => f.slice(ws.root().length+1)), retain:[...p.repos,"Shared documentation and models","Job logs, audit history, saved plans, config backups, and Git branches",...(p.platform && p.platform !== rt.platform.name ? ["Independent project configuration and indexes on the remote instance (remove there separately)"] : [])], pending_jobs:rt.queue.list(Number.MAX_SAFE_INTEGER).filter(j => j.project === p.name && j.status === "created").length};
  });
  app.delete("/api/projects/:id", async req => {
    local(req); const id = idOf(req);
    z.object({confirm:z.literal(true)}).parse(req.body);
    const p = await checkRemoval(id);
    // Recheck after the remote await: a local request may have started work meanwhile.
    if (rt.queue.hasActive(id) || engine.all().some(r => r.project === id && active(r.status))) fail(409,"Project work started during confirmation; try again when idle");
    const removed = removeProjectFiles(p); rt.queue.cancelPending(id);
    audit("user","project.remove",{project:id,removed});
    return {ok:true,message:`Removed project ${id}. Source repositories and shared resources are preserved.`,removed};
  });
  app.get("/api/tailscale", async () => tailscaleStatus());
  app.get("/api/capabilities", async () => detectHardware());
  app.post("/api/hooks", async req => executeHook(rt,req.body));
  if (!rt.config.roles.includes("control")) return;
  app.get("/api/platform-registry", async () => loadPlatforms().map(p => ({...p,...healthRecord(p.name)})));
  app.post("/api/platforms", async req => {
    local(req); const p = client(()=>validatePlatform(req.body));
    if (loadPlatforms().some(x => x.name === p.name)) fail(409,"Platform already exists");
    writeFileAtomic(join(ws.platforms(),`${p.name}.toml`),toToml(p)); audit("user","platform.add",{platform:p.name}); return p;
  });
  // Before saving: does an OpenHelper answer at this address? /api/health needs no token, so none is sent.
  app.post("/api/platforms/probe", async req => {
    local(req);
    const url = client(()=>apiOrigin(z.object({url:z.string()}).parse(req.body).url));
    try {
      const r = await fetch(`${url}/api/health`,{redirect:"error",signal:AbortSignal.timeout(4000)});
      const h = await r.json() as {ok?:boolean;platform?:string;version?:string};
      if (r.ok && h.ok) return {reachable:true,platform:h.platform ?? "",version:h.version ?? ""};
    } catch { /* reported below */ }
    return {reachable:false,message:`No OpenHelper API answered at ${url}. Check that it is running there, listening on its Tailscale address, and that the port is reachable on your tailnet. You can still save it and test again later.`};
  });
  app.put("/api/platforms/:id", async req => {
    local(req); const id = idOf(req); platform(id); const p = client(()=>validatePlatform(req.body));
    if (p.name !== id) fail(400,"Platform ID cannot change");
    if (rt.queue.hasActive() || engine.all().some(r => active(r.status) && r.steps.some(s => s.platform === id))) fail(409,"Wait for active jobs and workflows before changing platform configuration");
    writeFileAtomic(join(ws.platforms(),`${id}.toml`),toToml(p)); rt.reload(); audit("user","platform.edit",{platform:id}); return p;
  });
  app.post("/api/platforms/:id/test", async req => {
    local(req); const p = platform(idOf(req));
    const b = z.object({ssh:z.boolean().default(false)}).parse(req.body ?? {});
    if (b.ssh) return testSsh(p);
    try {
      const status = p.name === rt.platform.name ? await rt.status() : await new PeerClient(p).call("GET","/api/status",undefined,4000);
      audit("user","platform.test",{platform:p.name,reachable:true}); return {reachable:true,status,...rememberHealth(p.name)};
    } catch { audit("user","platform.test",{platform:p.name,reachable:false}); return {reachable:false,...healthRecord(p.name),message:"OpenHelper API is unavailable or authentication failed. Check its address, API port (usually 8740), secret reference and Tailscale connection. No work was sent."}; }
  });
  app.post("/api/platforms/:id/capabilities", async req => {
    local(req); const p = platform(idOf(req));
    const hw = p.name === rt.platform.name ? detectHardware() : await callHook<ReturnType<typeof detectHardware>>(rt.platform.name,p,"capabilities");
    p.measured = {...p.measured,cores:hw.cores,ram_gb:hw.ram_gb,cpu:hw.cpu,arch:hw.arch,gpu:hw.gpu.name,free_disk_gb:hw.free_disk_gb,detected_at:hw.detected_at};
    p.os = hw.os; writeFileAtomic(join(ws.platforms(),`${p.name}.toml`),toToml(p)); rt.reload(); audit("user","platform.detect",{platform:p.name}); return {hardware:hw};
  });
  app.post("/api/platforms/:id/hooks", async req => {
    local(req); const p = platform(idOf(req));
    const b = z.object({operation:z.string(),input:z.record(z.string(),z.unknown()).default({})}).parse(req.body);
    return callHook(rt.platform.name,p,b.operation,b.input);
  });
  app.delete("/api/platforms/:id", async req => {
    local(req); const id = idOf(req); platform(id); z.object({confirm:z.literal(true)}).parse(req.body);
    if (id === rt.platform.name) fail(409,"Cannot remove this instance's own platform");
    if (rt.queue.hasActive() || engine.all().some(r => active(r.status) && r.steps.some(s => s.platform === id))) fail(409,"An active job or workflow may depend on this platform");
    if (loadProjects().some(p => p.platform === id) || loadWorkflows().some(w => w.steps.some(s => resolvePlatform(s.platform,rt.config.aliases) === id)) || Object.values(rt.config.aliases).includes(id)) fail(409,"Remove project, workflow and alias references to this platform first");
    const links = loadLinks(); if (links.links.some(l => l.from === id || l.to === id)) fail(409,"Remove this platform's links in Settings first");
    rmSync(join(ws.platforms(),`${id}.toml`)); if (existsSync(healthFile(id))) rmSync(healthFile(id)); audit("user","platform.remove",{platform:id}); return {ok:true};
  });
}
