// Exercise installed clients against localhost with a dummy key and isolated homes.
// The mock rejects inference after capturing headers; no real model requests occur.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {spawn} from "node:child_process";
import {configureTool, resetTool, toolConfigPaths} from "../dist/lib/tool-config.js";
import {getHarness} from "../dist/lib/harnesses/registry.js";
import {parseConfig, setConfig} from "../dist/lib/config-formats.js";
import {writeJson, writeKey, writePreferences} from "../dist/lib/settings.js";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cn-header-wire-"));
const model = {id:"cn-header-probe", name:"Header probe", context:32768, output:1024, image:false, claude:true, codex:true, chat_candidate:true, reasoning:false};
const binaries = {codex:process.env.CN_PROBE_CODEX_BIN || "/Users/ajay/.local/bin/codex", opencode:process.env.CN_PROBE_OPENCODE_BIN || "/Users/ajay/.opencode/bin/opencode", pi:process.env.CN_PROBE_PI_BIN || "/Users/ajay/.local/bin/pi"};
console.log(`Isolated artifacts: ${root}`);
for (const id of ["codex", "opencode", "pi"]) {
 for (const mode of ["configure", "launch"]) {
  const home = path.join(root, `${id}-${mode}`);
  fs.mkdirSync(home);
  const env = {PATH:process.env.PATH, HOME:home, CODEX_HOME:path.join(home,"codex"), PI_CODING_AGENT_DIR:path.join(home,"pi"), XDG_CONFIG_HOME:path.join(home,"config"), XDG_DATA_HOME:path.join(home,"data"), XDG_CACHE_HOME:path.join(home,"cache"), CN_CONFIG_HOME:path.join(home,"cn"), CN_OFFLINE:"1", PI_OFFLINE:"1", NO_COLOR:"1"};
  fs.mkdirSync(env.CODEX_HOME, {recursive:true});
  writeKey("sk-cn-header-probe", env);
  writePreferences({codex:model.id, opencode:model.id, pi:model.id, claude:model.id}, env);
  writeJson(path.join(env.CN_CONFIG_HOME,"catalog.json"), {version:3, fetched_at:Date.now(), models:[model]});
  const captured = [];
  const server = http.createServer(async (req,res) => {
   let text=""; for await (const part of req) text+=part;
   let body={}; try {body=JSON.parse(text);} catch {}
   if(body.model) captured.push({app:req.headers["x-app"], model:body.model, url:req.url});
   res.writeHead(400, {"Content-Type":"application/json"});
   res.end(JSON.stringify({error:{message:"Local header probe complete", type:"invalid_request_error"}}));
  });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  let prepared;
  let restore;
  try {
   let args;
   if(mode === "configure") {
    await configureTool(id,env);
    const files=toolConfigPaths(id,env);
    const file=id === "pi" ? files.catalog : files.settings;
    const original=fs.readFileSync(file,"utf8");
    restore=()=>fs.writeFileSync(file,original);
    const parts=id === "codex" ? ["model_providers","cn_concentrate","base_url"] : id === "pi" ? ["providers","concentrate","baseUrl"] : ["providers","concentrate","settings","baseURL"];
    fs.writeFileSync(file,setConfig(original,id === "codex" ? "toml":"json",parts,endpoint));
    args=[];
   } else {
    prepared=await getHarness(id).prepare({executable:binaries[id],model:model.id,key:"sk-cn-header-probe",available:[model],forwarded:[],env});
    args=prepared.args.map(value=>value.replace("https://api.concentrate.ai/v1",endpoint));
    Object.assign(env,prepared.env);
    if(id === "pi") {
     const file=path.join(env.PI_CODING_AGENT_DIR,"models.json");
     const doc=parseConfig(fs.readFileSync(file,"utf8"),"json"); doc.providers.concentrate.baseUrl=endpoint; writeJson(file,doc);
    }
    if(id === "opencode") env.OPENCODE_CONFIG_CONTENT=env.OPENCODE_CONFIG_CONTENT.replace("https://api.concentrate.ai/v1",endpoint);
   }
   if(id === "codex") {
    // Keep top-level -c options together; exec's own list otherwise replaces them.
    args = [...args, "-c", 'web_search="disabled"', "exec", "--skip-git-repo-check", "--ephemeral", "Reply OK"];
   }
   if(id === "pi") args.push("-p","--no-session","--no-extensions","--no-skills","--no-prompt-templates","--no-themes","--no-context-files","--no-tools","--offline","Reply OK");
   if(id === "opencode") args=["run","--standalone","--model",`concentrate/${model.id}`,"Reply OK"];
   await new Promise((resolve,reject)=>{
    const child=spawn(binaries[id],args,{env,cwd:home,stdio:["pipe","pipe","pipe"]});
    child.stdin.end();
    let output=""; child.stdout.on("data",part=>output+=part); child.stderr.on("data",part=>output+=part);
    const timeout=setTimeout(()=>child.kill("SIGKILL"),25000);
    child.on("error",reject);
    child.on("close",()=>{clearTimeout(timeout);fs.writeFileSync(path.join(home,"client.log"),output);resolve();});
   });
   assert.ok(captured.length,`${id} ${mode}: no request captured, see ${home}/client.log`);
   for(const request of captured) assert.equal(request.app,id,JSON.stringify(request));
   console.log(`${id} ${mode}: X-App=${id} received (${captured.length} requests)`);
  } finally {
   restore?.();
   if(mode === "configure") resetTool(id,env);
   prepared?.cleanup();
   server.closeAllConnections();
   await new Promise(resolve=>server.close(resolve));
  }
 }
}
