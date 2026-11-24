import { cpSync, mkdirSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type App } from "../src/app.js";
import { toToml } from "../src/core/fsutil.js";
import { findProject, loadPlatforms } from "../src/core/load.js";
import { Platform, Project } from "../src/core/schemas.js";
import { ensureApiToken } from "../src/core/secrets.js";
import { buildIndex, openIndex } from "../src/index/build.js";
import { estimateIndex, type Workload } from "../src/index/estimate.js";
import { tailscaleStatus } from "../src/platform-management.js";
import { REPO_ROOT, samplePythonRepo, tempWorkspace, write } from "./helpers.js";
let a:App, root:string, repo:string, token:string;
const auth=()=>({authorization:`Bearer ${token}`});
const request=(method:"GET"|"POST"|"PUT"|"DELETE",url:string,payload?:object,remoteAddress="127.0.0.1")=>a.app.inject({method,url,headers:auth(),...(payload?{payload}:{}),remoteAddress});
const configured=(name="demo")=>({project:{name,repos:[repo],languages:["python"],language_mode:"selected",checks:["python/compile"],docs:[],platform:"desktop",model:"qwen3-8b-q4km",search:"keyword",exclude:["private/**"]},confirm:true});
beforeEach(async()=>{
  root=tempWorkspace();cpSync(join(REPO_ROOT,"workspace.example"),root,{recursive:true});repo=samplePythonRepo();token=ensureApiToken();a=await buildApp();
  vi.spyOn(a.rt.llm,"healthy").mockResolvedValue(false);
});
afterEach(async()=>{await a?.app.close();vi.restoreAllMocks();});

describe("guided project registration",()=>{
  it("previews without saving and requires final confirmation",async()=>{
    const preview=await request("POST","/api/projects/preview",{repos:[repo]});expect(preview.statusCode).toBe(200);expect(preview.json().languages).toContain("python");
    expect(existsSync(join(root,"projects","demo.toml"))).toBe(false);
    const b=configured();expect((await request("POST","/api/projects/configure",{project:b.project})).statusCode).toBe(400);
    expect((await request("POST","/api/projects/configure",b)).statusCode).toBe(200);
    expect(findProject("demo")).toMatchObject(b.project);expect(a.rt.queue.list()).toHaveLength(0);expect(openIndex("demo")).toBeUndefined();
    expect((await request("POST","/api/projects/configure",b)).statusCode).toBe(400);
  });
  it("validates selected packs, models, hybrid embeddings and repository paths",async()=>{
    for(const change of [{docs:["unknown"]},{model:"unknown"},{search:"hybrid",embed_model:""},{repos:["/not/a/repo"]},{checks:["python/not-real"]},{platform:"missing"}]){
      const b=configured();expect((await request("POST","/api/projects/configure",{...b,project:{...b.project,...change}})).statusCode).toBe(400);
    }
  });
  it("keeps legacy TOML defaults and explicit no-check selection",async()=>{
    const old=Project.parse({name:"old",repos:[repo]});expect(old).toMatchObject({platform:"",language_mode:"auto",search:"platform-default"});
    const b=configured();b.project.checks=[];b.project.languages=[];await request("POST","/api/projects/configure",b);
    const result=await request("POST","/api/jobs",{type:"index",project:"demo",start:true});
    const done=await a.rt.queue.wait(result.json().id);expect(done.status).toBe("done");expect(done.output?.embed_model).toBe("");expect(done.progress?.phase).toBe("complete");
    expect(done.progress!.files_processed).toBeGreaterThan(0);expect(existsSync(join(root,"state","index-timings.json"))).toBe(true);
    const estimate=await request("GET","/api/projects/demo/estimate");expect(estimate.json().basis).toContain("historical");
  });
});
describe("changing a saved project's models and embeddings",()=>{
  it("saves new models and search mode without touching other settings, and validates them",async()=>{
    await request("POST","/api/projects/configure",configured());
    const r=await request("PUT","/api/projects/demo/settings",{light_model:"qwen3-8b-q4km",search:"hybrid",embed_model:"qwen3-embedding-0.6b-q8"});
    expect(r.statusCode).toBe(200);
    expect(findProject("demo")).toMatchObject({light_model:"qwen3-8b-q4km",search:"hybrid",embed_model:"qwen3-embedding-0.6b-q8",model:"qwen3-8b-q4km",exclude:["private/**"]});
    expect((await request("PUT","/api/projects/demo/settings",{embed_model:"qwen3-8b-q4km"})).statusCode).toBe(400);
    expect((await request("PUT","/api/projects/demo/settings",{repos:["/elsewhere"]})).statusCode).toBe(400);
    expect((await request("PUT","/api/projects/demo/settings",{search:"keyword"},"100.64.0.2")).statusCode).toBe(200);
    expect((await request("PUT","/api/projects/missing/settings",{search:"keyword"})).statusCode).toBe(404);
  });
  it("refuses to export a keyword-only index and to import a file that is not an export",async()=>{
    await request("POST","/api/projects/configure",configured());await buildIndex(findProject("demo"));
    const ex=await request("POST","/api/projects/demo/embeddings/export");expect(ex.statusCode).toBe(400);expect(ex.json().error).toContain("no embeddings");
    write(root,"junk.gz","not gzip");
    expect((await request("POST","/api/embeddings/import",{path:join(root,"junk.gz")})).json().error).toContain("not an embeddings export");
    expect((await request("POST","/api/embeddings/import",{path:join(root,"missing.gz")})).statusCode).toBe(400);
  });
});
describe("safe project removal",()=>{
  beforeEach(async()=>{await request("POST","/api/projects/configure",configured());});
  it("requires authorization, local access, explicit confirmation, and an existing project",async()=>{
    expect((await a.app.inject({method:"DELETE",url:"/api/projects/demo",payload:{confirm:true}})).statusCode).toBe(401);
    expect((await request("DELETE","/api/projects/demo",{confirm:true},"100.64.0.2")).statusCode).toBe(403);
    expect((await request("DELETE","/api/projects/demo",{})).statusCode).toBe(400);
    expect((await request("DELETE","/api/projects/missing",{confirm:true})).statusCode).toBe(404);
  });
  it("cleans its index, evals, results and staged config, preserves source/shared/history, and audits",async()=>{
    await buildIndex(findProject("demo"));expect(openIndex("demo")).toBeDefined();
    const shared=write(root,"docs/shared/page.md","keep");const model=write(root,"models/shared.gguf","keep");
    for(const path of ["evals/demo/tasks.jsonl","results/demo/scores.json",".staged/projects/demo.toml"])write(root,path,"temporary");
    const pending=a.rt.queue.create({type:"index",project:"demo",platform:"desktop",model:"",input:{}});
    const plan=await request("GET","/api/projects/demo/removal");expect(plan.json().pending_jobs).toBe(1);expect(plan.json().remove).toContain("index/demo");
    const removed=await request("DELETE","/api/projects/demo",{confirm:true});expect(removed.statusCode).toBe(200);
    for(const path of ["projects/demo.toml","index/demo","evals/demo","results/demo",".staged/projects/demo.toml"])expect(existsSync(join(root,path))).toBe(false);
    expect(openIndex("demo")).toBeUndefined();expect(existsSync(join(repo,".git"))).toBe(true);expect(existsSync(join(repo,"calc/ops.py"))).toBe(true);expect(existsSync(shared)).toBe(true);expect(existsSync(model)).toBe(true);
    expect(a.rt.queue.get(pending.id)?.status).toBe("canceled");expect((await request("GET","/api/audit")).json().some((e:{action:string})=>e.action==="project.remove")).toBe(true);
  });
  it("blocks queued work and running handlers even after cancellation is requested",async()=>{
    a.rt.queue.pause(true);const j=a.rt.queue.create({type:"index",project:"demo",platform:"desktop",model:"",input:{}});a.rt.queue.start(j.id);
    expect((await request("DELETE","/api/projects/demo",{confirm:true})).statusCode).toBe(409);a.rt.queue.cancel(j.id);
    let release!:()=>void;vi.spyOn(a.rt.llm,"chat").mockImplementation(()=>new Promise(resolve=>{release=()=>resolve({content:"done",usage:{prompt_tokens:0,completion_tokens:0}} as never);}));
    const run=a.rt.queue.create({type:"explain",project:"demo",platform:"desktop",model:"",input:{task:"hello"}});a.rt.queue.pause(false);a.rt.queue.start(run.id);
    await vi.waitFor(()=>expect(release).toBeTypeOf("function"));a.rt.queue.cancel(run.id);
    expect((await request("DELETE","/api/projects/demo",{confirm:true})).statusCode).toBe(409);release();await vi.waitFor(()=>expect(a.rt.queue.state().running).toBeUndefined());
  });
  it("blocks active workflows, including approval gates",async()=>{
    vi.spyOn(a.engine,"all").mockReturnValue([{project:"demo",status:"waiting-approval"}] as never);
    expect((await request("DELETE","/api/projects/demo",{confirm:true})).statusCode).toBe(409);
  });
  it("refuses cleanup paths that overlap a repository",async()=>{
    mkdirSync(join(root,"index"),{recursive:true});symlinkSync(repo,join(root,"index","demo"),"dir");
    expect((await request("DELETE","/api/projects/demo",{confirm:true})).statusCode).toBeGreaterThanOrEqual(400);expect(existsSync(join(repo,"calc/ops.py"))).toBe(true);expect(existsSync(join(root,"projects/demo.toml"))).toBe(true);
  });
});

describe("machine registry and hooks",()=>{
  const remote=()=>({...loadPlatforms()[0],name:"remote",display_name:"Workshop",os:"windows",connection:"tailscale",url:"http://workshop.example.ts.net:8740",token_ref:"remote",tailscale_hostname:"workshop.example.ts.net"});
  it("registers and edits platform-independent settings without secrets",async()=>{
    expect((await request("POST","/api/platforms",remote())).statusCode).toBe(200);
    expect((await request("PUT","/api/platforms/remote",{...remote(),agents:["explainer"]})).statusCode).toBe(200);
    const registry=(await request("GET","/api/platform-registry")).json();expect(registry.find((p:{name:string})=>p.name==="remote")).toMatchObject({os:"windows",token_ref:"remote",agents:["explainer"]});
    expect((await request("POST","/api/platforms",{...remote(),name:"unsafe",url:"http://user:secret@host:8740"})).statusCode).toBe(400);
    expect((await request("POST","/api/platforms",{...remote(),name:"unsafe",auto_run:true})).statusCode).toBe(400);
    expect((await request("POST","/api/platforms",{...remote(),name:"unsafe"},"100.64.0.2")).statusCode).toBe(403);
    expect((await request("DELETE","/api/platforms/remote",{confirm:true})).statusCode).toBe(200);
    expect((await request("DELETE","/api/platforms/desktop",{confirm:true})).statusCode).toBe(409);
  });
  it("reports offline health clearly and persists a successful local check",async()=>{
    await request("POST","/api/platforms",remote());
    expect((await request("POST","/api/platforms/remote/test")).json()).toMatchObject({reachable:false});
    expect((await request("POST","/api/platforms/desktop/test")).json()).toMatchObject({reachable:true,last_success:expect.any(String)});
    const detected=await request("POST","/api/platforms/desktop/capabilities");expect(detected.statusCode).toBe(200);expect(detected.json().hardware.cores).toBeGreaterThan(0);
  });
  it("probes a new address before saving, without sending a token",async()=>{
    const seen:string[]=[];
    const srv=createServer((req,res)=>{seen.push(String(req.headers.authorization ?? ""));res.setHeader("content-type","application/json");res.end(JSON.stringify({ok:true,platform:"workshop",version:"9.9.9"}));});
    await new Promise<void>(r=>srv.listen(0,"127.0.0.1",()=>r()));const port=(srv.address() as AddressInfo).port;
    try {
      expect((await request("POST","/api/platforms/probe",{url:`http://127.0.0.1:${port}`})).json()).toEqual({reachable:true,platform:"workshop",version:"9.9.9"});
      expect(seen).toEqual([""]);
    } finally { srv.close(); }
    expect((await request("POST","/api/platforms/probe",{url:`http://127.0.0.1:${port}`})).json()).toMatchObject({reachable:false,message:expect.stringContaining("You can still save it")});
    expect((await request("POST","/api/platforms/probe",{url:"http://user:pw@host:8740"})).statusCode).toBe(400);
    expect((await request("POST","/api/platforms/probe",{url:"http://127.0.0.1:1"},"100.64.0.2")).statusCode).toBe(403);
  });
  it("blocks platform removal when a project references it",async()=>{
    await request("POST","/api/platforms",remote());const b=configured();b.project.platform="remote";await request("POST","/api/projects/configure",b);
    expect((await request("DELETE","/api/platforms/remote",{confirm:true})).statusCode).toBe(409);
    expect((await request("DELETE","/api/projects/demo",{confirm:true})).statusCode).toBe(409); // cannot confirm remote is idle
  });
  it("requires an allowlisted operation, sender, link, budget, role and job ownership",async()=>{
    await request("POST","/api/projects/configure",configured());
    const envelope={from:"mac",hops:1,tokens:0,started_at:new Date().toISOString()};
    const hook=(operation:string,input:object={},env=envelope)=>request("POST","/api/hooks",{operation,input,envelope:env});
    expect((await hook("shell",{command:"echo unsafe"})).statusCode).toBe(400);
    expect((await hook("health")).statusCode).toBe(403);
    write(root,"links.toml",'kill_switch = false\n[[links]]\nfrom = "mac"\nto = "desktop"\nmode = "one-way"\n');
    expect((await hook("health")).statusCode).toBe(200);
    expect((await hook("health",{},{...envelope,hops:999})).statusCode).toBe(403);
    expect((await hook("health",{},{...envelope,tokens:999999})).statusCode).toBe(403);
    expect((await hook("health",{},{...envelope,started_at:"invalid"})).statusCode).toBe(400);
    expect((await hook("start-job",{project:"demo",type:"explain"})).statusCode).toBe(403);
    const p=a.rt.platform;p.hooks.push("index","start-job","cancel-job");p.agents=[];write(root,"platforms/desktop.toml",toToml(p));a.rt.reload();
    expect((await hook("start-job",{project:"demo",type:"explain"})).statusCode).toBe(403);
    const started=await hook("index",{project:"demo"});expect(started.statusCode).toBe(200);await a.rt.queue.wait(started.json().id);
    expect((await hook("job-status",{id:started.json().id})).statusCode).toBe(200);
    const localJob=a.rt.queue.create({type:"index",project:"demo",platform:"desktop",model:"",input:{}});
    expect((await hook("job-status",{id:localJob.id})).statusCode).toBe(404);
    write(root,"links.toml",'kill_switch = true\n');expect((await hook("health")).statusCode).toBe(403);
    expect((await request("GET","/api/audit/verify")).json().first_broken).toBe(-1);
  });
});

describe("capability estimates and Tailscale",()=>{
  const work:Workload={files:100,chunks:500,doc_files:20,missing_docs:[]};
  it("uses broad initial estimates, per-platform/model history, and measured benchmarks",()=>{
    const p=Platform.parse({name:"cpu",url:"http://localhost:8740",model:{current:"x"},measured:{cores:2,ram_gb:4}});
    const generic=estimateIndex(p,work,"",[]);expect(generic.confidence).toBe("low");expect(generic.basis).toContain("initial");expect(generic.max_s).toBeGreaterThan(generic.min_s);
    expect(estimateIndex(p,work,"embedding",[]).max_s).toBeGreaterThan(generic.max_s);
    const samples=Array.from({length:3},()=>({platform:"cpu",embed_model:"",files:100,chunks:500,duration_ms:10000,at:new Date().toISOString()}));
    expect(estimateIndex(p,work,"",samples)).toMatchObject({confidence:"medium",basis:"historical data (3 builds)"});
    expect(estimateIndex({...p,name:"other"},work,"",samples).confidence).toBe("low");expect(estimateIndex(p,work,"other-model",samples).confidence).toBe("low");
    expect(estimateIndex({...p,measured:{index_chunks_per_second:100}},work,"",[]).basis).toBe("benchmark");
  });
  it("handles available, unavailable and signed-out Tailscale without returning peer lists or secrets",async()=>{
    const run=vi.fn().mockResolvedValue({stdout:JSON.stringify({BackendState:"Running",Self:{DNSName:"machine.example.ts.net",TailscaleIPs:["fd7a::1","100.64.0.2"]},Peer:{secret:"do not return"}})});
    const result=await tailscaleStatus(run as never);expect(result).toMatchObject({available:true,online:true,hostname:"machine.example.ts.net",ipv4:"100.64.0.2"});expect(JSON.stringify(result)).not.toContain("secret");
    expect(await tailscaleStatus(vi.fn().mockRejectedValue(new Error("ENOENT")) as never)).toMatchObject({available:false});
    expect(await tailscaleStatus(vi.fn().mockResolvedValue({stdout:'{"BackendState":"NeedsLogin"}'}) as never)).toMatchObject({available:true,online:false,ipv4:""});
  });
});
