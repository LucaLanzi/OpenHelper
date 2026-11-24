import { createRoot } from "react-dom/client";
import { useState } from "react";
import { AppProvider } from "../src/context";
import { ToastProvider } from "../src/components/ui";
import { Projects } from "../src/pages/Projects";
import { Library } from "../src/pages/Admin";
import { Platforms } from "../src/pages/Platforms";
import { Models } from "../src/pages/Models";
import { IndexEstimate, IndexProgressView } from "../src/components/IndexEstimate";
import "../src/styles.css";
const mode=new URLSearchParams(location.search).get("component");
function Harness(){return <ToastProvider><AppProvider><main>{mode==="platforms"?<Platforms/>:mode==="models"?<Models/>:mode==="library"?<Library/>:mode==="eta"?<><IndexEstimate estimate={{platform:"Workshop",min_s:60,max_s:180,basis:"initial capability estimate",confidence:"low",explanation:"100 files, keyword search; downloads excluded"}}/><IndexProgressView progress={{phase:"embedding",files_discovered:100,files_processed:100,chunks:500,embeddings_completed:32,elapsed_ms:1000,eta_min_s:60,eta_max_s:180}}/><pre id="job-log">Log output</pre></>:<Projects/>}</main></AppProvider></ToastProvider>;}
createRoot(document.getElementById("root")!).render(<Harness/>);
