/** Component interactions in a real browser; no DOM shim or external service required.
 * Uses an existing Playwright installation via OPENHELPER_PLAYWRIGHT_MODULE when needed.
 */
import assert from "node:assert/strict";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
let chromium;
try{({chromium}=await import(process.env.OPENHELPER_PLAYWRIGHT_MODULE || "playwright"));}
catch{console.log("Skipped dashboard browser tests: Playwright is not installed. Install it, or set OPENHELPER_PLAYWRIGHT_MODULE (and OPENHELPER_CHROME to use an installed Chrome).");process.exit(0);}
const server=await createServer({root:fileURLToPath(new URL("../",import.meta.url)),server:{host:"127.0.0.1",port:0}});
await server.listen();
const port=server.httpServer.address().port;
const browser=await chromium.launch({headless:true,...(process.env.OPENHELPER_CHROME ? {executablePath:process.env.OPENHELPER_CHROME} : {})});
const errors=[];
const platform={name:"desktop",display_name:"Local computer",description:"A machine",os:"other",connection:"api",url:"http://127.0.0.1:8740",token_ref:"desktop",tailscale_hostname:"",tailscale_ipv4:"",ssh:{host:"",port:22,user:"",auth_ref:""},agents:["planner","coder","reviewer","explainer"],hooks:["health","capabilities","models","job-status","job-logs"],model:{current:"main",light:"fast",embed:"embed",allowed:["main","fast"]},sandbox:{driver:"none",image:"test",vm:"test"},auto_run:false,measured:{cores:4},self:true,reachable:false};
const remote={...platform,name:"remote",display_name:"Workshop",self:false,url:"http://workshop.example.ts.net:8740",model:{...platform.model,current:"fast"}};
const docs=[{id:"python",name:"Python reference",version:"3.14",license:"PSF",notes:"Standard library reference",homepage:"https://docs.python.org",sources:[{}],local_command:"",status:{fetched:true,files:20}},{id:"manual",name:"Local manual",version:"1",license:"MIT",notes:"Project reference",homepage:"https://example.org",sources:[],local_command:"",status:{fetched:false,files:0}}];
const languages=[{id:"python",name:"Python",detect:["**/*.py"],checks:["Compile"],sandbox:"none",details:[{id:"compile",name:"Compile",kind:"syntax",requires:["python3"],when_files:[]}]}];
const models=[{id:"main",name:"Main model",roles:["main"]},{id:"fast",name:"Fast model",roles:["light"]},{id:"embed",name:"Embedding model",roles:["embed"]}];
const estimate={platform:"Workshop",min_s:60,max_s:180,basis:"initial capability estimate",confidence:"low",explanation:"Initial estimate based on selected files"};
const project={name:"demo",repos:["/repo"],languages:["python"],docs:["python"],platform:"desktop",model:"main",light_model:"fast",search:"keyword",exclude:[],index:null,eval_tasks:0};
let passed=0;
async function fixture(component,opts={}){
 const page=await browser.newPage();page.on("pageerror",e=>errors.push(e.message));const calls=[];
 await page.route("**/api/**",async route=>{
  const r=route.request(),path=new URL(r.url()).pathname.replace(/^\/api/,"");const data=r.postDataJSON();calls.push({path,method:r.method(),data});
  let value={};
  if(path==="/health")value={platform:"desktop",roles:["node","control"]};
  else if(path==="/projects")value=opts.project?[project]:[];
  else if(path==="/project-options")value={platforms:[platform,remote],models,languages,docs,self:"desktop"};
  else if(path==="/host")value={local:true,picker:false};
  else if(path==="/projects/preview")value={name:"demo",repos:data.repos,languages:["python"],docs:["python"]};
  else if(path==="/projects/configure")value={project:data.project};
  else if(path==="/index/estimate" || path.endsWith("/estimate"))value=estimate;
  else if(path.endsWith("/removal"))value={remove:["projects/demo.toml","index/demo","evals/demo"],retain:["/repo","Shared documentation and models"],pending_jobs:0};
  else if(path==="/models/all")value=[{id:"spare",name:"Spare model",kind:"dense",quant:"Q4_K_M",size_gb:5,roles:["main"],license:"MIT",present:true,pinned:true,has_source:true,uses:[],can_tune:false},{id:"main",name:"Main model",kind:"dense",quant:"Q4_K_M",size_gb:9,roles:["main"],license:"MIT",present:true,pinned:true,has_source:true,uses:["main"],can_tune:false}];
  else if(path.endsWith("/file") && r.method()==="DELETE")value={ok:true,freed_bytes:5e9};
  else if(r.method()==="DELETE")value={ok:true,message:"Removed project demo. Repositories preserved."};
  else if(path.startsWith("/results"))value=[];
  else if(path==="/docs")value=docs;
  else if(path==="/languages")value=languages;
  else if(path==="/platforms/probe")value=opts.probe ?? {reachable:false,message:"No OpenHelper API answered at http://workshop.example.ts.net:8740. You can still save it and test again later."};
  else if(path==="/platforms")value=r.method()==="GET"?[platform,remote]:data;
  else if(path==="/links")value={kill_switch:false,links:[],matrix:[]};
  else if(path==="/tailscale")value=opts.tailscale ?? {available:false,online:false,hostname:"",ipv4:"",message:"Tailscale is unavailable. Direct API connections also work."};
  else if(path.endsWith("/test"))value={reachable:false,message:"OpenHelper API unavailable; no work sent"};
  else if(path==="/jobs")value={id:"index-test"};
  await route.fulfill({json:value});
 });
 await page.goto(`http://127.0.0.1:${port}/test/index.html?component=${component}`);return {page,calls};
}
async function test(name,fn){try{await fn();passed++;console.log(`PASS ${name}`);}catch(e){console.error("Browser errors:",errors);for(const context of browser.contexts())for(const page of context.pages())console.error(await page.locator("body").innerText());throw e;}}
try{
 await test("guided creation persists choices only after consolidated confirmation",async()=>{
  const {page,calls}=await fixture("projects");
  await page.getByLabel("Repository 1",{exact:true}).fill("/repo");await page.getByRole("button",{name:"Add another repository"}).click();await page.getByLabel("Repository 2",{exact:true}).fill("/second");
  await page.getByRole("button",{name:"Detect languages and continue"}).click();await page.getByText("Detected: python.",{exact:false}).waitFor();assert.equal(calls.some(c=>c.path==="/projects/configure"),false);
  await page.getByRole("button",{name:"Continue",exact:true}).click();await page.getByLabel("Search documentation").fill("manual");await page.getByLabel("Use Local manual for this project").check();
  await page.getByRole("button",{name:"Continue",exact:true}).click();await page.getByLabel("Execution platform").selectOption("remote");await page.getByLabel("Project model",{exact:true}).selectOption("main");await page.getByLabel("Light / fast model",{exact:true}).selectOption("fast");
  await page.getByRole("button",{name:"Continue",exact:true}).click();await page.getByLabel("Search mode").selectOption("hybrid");await page.getByLabel("Embedding model",{exact:true}).selectOption("embed");await page.getByLabel("Exclude paths",{exact:false}).fill("private/**\ngenerated/**");
  await page.getByRole("button",{name:"Continue",exact:true}).click();await page.getByRole("heading",{name:"Review demo",exact:true}).waitFor();assert.equal(calls.some(c=>c.path==="/projects/configure"),false);await page.getByRole("status",{name:"Index time estimate"}).waitFor();
  await page.getByRole("button",{name:"Confirm and create project"}).click();await page.getByRole("heading",{name:"Set up a project · Repository source"}).waitFor();
  const saved=calls.find(c=>c.path==="/projects/configure");assert.equal(saved.data.confirm,true);assert.deepEqual(saved.data.project.repos,["/repo","/second"]);assert.equal(saved.data.project.platform,"remote");assert.equal(saved.data.project.model,"main");assert.equal(saved.data.project.light_model,"fast");assert.deepEqual(saved.data.project.docs,["python","manual"]);assert.deepEqual(saved.data.project.exclude,["private/**","generated/**"]);assert.equal(calls.some(c=>c.path==="/jobs"),false);await page.close();
 });
 await test("removal dialog names cleanup, traps keyboard focus, restores focus, and requires confirmation",async()=>{
  const {page,calls}=await fixture("projects",{project:true});const remove=page.getByRole("button",{name:"Remove project",exact:true});await remove.click();const dialog=page.getByRole("dialog",{name:"Remove project demo?"});await dialog.waitFor();assert.match(await dialog.innerText(),/index\/demo/);assert.match(await dialog.innerText(),/Shared documentation and models/);assert.equal(await page.getByRole("button",{name:"Cancel",exact:true}).evaluate(e=>document.activeElement===e),true);
  await page.keyboard.press("Shift+Tab");assert.equal(await dialog.evaluate(d=>d.contains(document.activeElement)),true);await page.keyboard.press("Escape");await dialog.waitFor({state:"detached"});assert.equal(calls.some(c=>c.method==="DELETE"),false);assert.equal(await remove.evaluate(e=>document.activeElement===e),true);
  await remove.click();await page.getByRole("button",{name:"Confirm removal"}).click();await dialog.waitFor({state:"detached"});assert.equal(calls.find(c=>c.method==="DELETE").data.confirm,true);await page.close();
 });
 await test("deleting a model file needs confirmation and is blocked for a model in use",async()=>{
  const {page,calls}=await fixture("models");const rows=page.getByRole("row");
  assert.equal(await rows.filter({hasText:"Main model"}).getByRole("button",{name:"Delete file"}).isDisabled(),true);
  await rows.filter({hasText:"Spare model"}).getByRole("button",{name:"Delete file"}).click();const dialog=page.getByRole("dialog",{name:"Delete Spare model?"});await dialog.waitFor();assert.match(await dialog.innerText(),/download it again/);
  await page.keyboard.press("Escape");await dialog.waitFor({state:"detached"});assert.equal(calls.some(c=>c.method==="DELETE"),false);
  await rows.filter({hasText:"Spare model"}).getByRole("button",{name:"Delete file"}).click();await page.getByRole("button",{name:"Delete 5 GB"}).click();await page.getByText("Freed 5.0 GB",{exact:false}).waitFor();
  const d=calls.find(c=>c.method==="DELETE");assert.equal(d.path,"/models/spare/file");assert.equal(d.data.confirm,true);await page.close();
 });
 await test("Library shares searchable documentation cards and explains checks and missing tools",async()=>{
  const {page}=await fixture("library");await page.getByLabel("Search documentation").fill("Python");await page.getByRole("heading",{name:"Python reference 3.14"}).waitFor();assert.equal(await page.getByRole("heading",{name:"Local manual 1"}).count(),0);await page.getByText("Python · 1 checks",{exact:true}).click();await page.getByText("Missing tools cause checks",{exact:false}).waitFor();await page.close();
 });
 await test("Tailscale absent and hostname onboarding configure a machine without credentials",async()=>{
  const {page,calls}=await fixture("platforms");await page.getByText("Connect another OpenHelper instance with Tailscale",{exact:true}).click();await page.getByText("Tailscale is unavailable.",{exact:false}).waitFor();await page.getByLabel("Remote Tailscale hostname or IP").fill("workshop.example.ts.net");await page.getByRole("button",{name:"Check this address"}).click();await page.getByRole("status").filter({hasText:"You can still save it"}).waitFor();assert.equal(calls.find(c=>c.path==="/platforms/probe").data.url,"http://workshop.example.ts.net:8740");await page.getByRole("button",{name:"Configure this remote platform"}).click();assert.equal(await page.getByLabel("OpenHelper API URL",{exact:true}).inputValue(),"http://workshop.example.ts.net:8740");await page.getByLabel("Platform ID",{exact:true}).fill("workshop");await page.getByLabel("Display name",{exact:true}).fill("Workshop");await page.getByLabel("API authentication reference",{exact:false}).fill("workshop");await page.getByRole("button",{name:"Save platform",exact:true}).click();assert.equal(calls.find(c=>c.path==="/platforms" && c.method==="POST").data.token_ref,"workshop");await page.close();
 });
 await test("Tailscale available and offline health remain readable status messages",async()=>{
  const {page}=await fixture("platforms",{tailscale:{available:true,online:true,hostname:"local.example.ts.net",ipv4:"100.64.0.2"}});await page.getByText("Connect another OpenHelper instance with Tailscale",{exact:true}).click();await page.getByText("This machine: local.example.ts.net",{exact:false}).waitFor();await page.getByRole("button",{name:"Test connectivity / refresh health"}).first().click();await page.getByRole("status").filter({hasText:"OpenHelper API unavailable"}).waitFor();await page.close();
 });
 await test("ETA exposes platform, range, basis, confidence, counters and log link",async()=>{
  const {page}=await fixture("eta");const status=page.getByRole("status",{name:"Index time estimate"});await status.waitFor();assert.match(await status.innerText(),/1 min–3 min on Workshop/);assert.match(await status.innerText(),/low confidence/);await page.getByRole("status",{name:"Index progress"}).waitFor();await page.getByRole("link",{name:"Full job log"}).click();assert.equal(new URL(page.url()).hash,"#job-log");await page.close();
 });
 assert.deepEqual(errors,[]);console.log(`${passed} browser component tests passed.`);
}finally{await browser.close();await server.close();}
