// Real Claude Code against a localhost mock. Dummy key, isolated home,
// no user files, external requests, upstream inference, or paid calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
const { prepareClaudeContext } = await import(process.env.CN_PROBE_CONTEXT_MODULE || "../dist/lib/claude-context.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cn-capability-probe-"));
const available = [
  { id: "cn-test-small", context: 128000, output: 4096, reasoningSupport: false, efforts: ["none"] },
  { id: "cn-test-large", context: 400000, output: 64000, reasoningSupport: true, efforts: ["low", "medium"] },
  { id: "claude-sonnet-4-6", context: 200000, output: 64000 },
];
const plugin = prepareClaudeContext({ available });
const requests = [];
const server = http.createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) { res.writeHead(200, {"content-type":"application/json"}); res.end("{}"); return; }
  const body = JSON.parse(raw);
  requests.push({ model: body.model, output: body.max_tokens, thinking: body.thinking?.type ?? null, effort: body.output_config?.effort ?? null });
  const msg = {id:"msg_probe",type:"message",role:"assistant",model:body.model,content:[{type:"text",text:"OK"}],stop_reason:"end_turn",stop_sequence:null,usage:{input_tokens:50,output_tokens:1}};
  if (!body.stream) { res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify(msg)); return; }
  res.writeHead(200,{"content-type":"text/event-stream"});
  for (const [event,data] of [
    ["message_start",{type:"message_start",message:{...msg,content:[],stop_reason:null}}],
    ["content_block_start",{type:"content_block_start",index:0,content_block:{type:"text",text:""}}],
    ["content_block_delta",{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"OK"}}],
    ["content_block_stop",{type:"content_block_stop",index:0}],
    ["message_delta",{type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:1}}],
    ["message_stop",{type:"message_stop"}],
  ]) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
});
let child, timer;
try {
  await new Promise((resolve,reject) => { server.on("error", reject); server.listen(0,"127.0.0.1",resolve); });
  const home = path.join(root,"home"), cwd = path.join(root,"workspace");
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const env = {PATH:process.env.PATH,HOME:home,CLAUDE_CONFIG_DIR:path.join(home,".claude"),ANTHROPIC_API_KEY:"sk-dummy-capability-probe",ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",DISABLE_AUTOUPDATER:"1",DISABLE_TELEMETRY:"1"};
  const args = ["--plugin-dir",plugin.directory,"--model","cn-test-small","--settings",JSON.stringify({modelPicker:{replaceBuiltInOptions:true,options:available.map(m=>({model:m.id,label:m.id}))}}),"--tools","","--effort","max","--no-session-persistence","--input-format","stream-json","--output-format","stream-json","--verbose","-p"];
  child = spawn(process.env.CN_PROBE_CLAUDE_BIN || "claude",args,{cwd,env,stdio:["pipe","pipe","pipe"]});
  const commands = ["Say OK", "/model cn-test-large", "Say OK", "/model claude-sonnet-4-6", "Say OK", "/model cn-test-small", "Say OK", "/model cn-test-large", "Say OK"];
  let index = 0, buffer = "", errors = "";
  const failures = [];
  const send = () => { if(index===commands.length){child.stdin.end();return;} child.stdin.write(JSON.stringify({type:"user",message:{role:"user",content:commands[index++]}})+"\n"); };
  child.stderr.on("data",d=>{errors+=d;});
  child.stdout.on("data",d=>{buffer+=d;for(;;){const end=buffer.indexOf("\n");if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let item;try{item=JSON.parse(line)}catch{continue;}if(item.type!=="result")continue;if(item.is_error)failures.push(item.result);send();}});
  send(); timer = setTimeout(()=>child.kill("SIGTERM"),30000);
  const code=await new Promise((resolve,reject)=>{child.on("error",reject);child.on("exit",resolve);});
  assert.equal(code,0,errors);
  assert.deepEqual(failures,[]);
  assert.equal(requests.length,5,JSON.stringify(requests));
  assert.deepEqual(requests.map(r=>r.model),["cn-test-small","cn-test-large","claude-sonnet-4-6","cn-test-small","cn-test-large"]);
  for (const request of requests.filter(r=>r.model==="cn-test-small")) { assert.equal(request.output,4096); assert.equal(request.thinking,null); }
  for (const request of requests.filter(r=>r.model==="cn-test-large")) { assert.equal(request.output,32000); assert.equal(request.thinking,"adaptive"); assert.equal(request.effort,"medium"); }
  console.log(JSON.stringify({requests,paidCalls:0,passed:true},null,2));
} finally {
  clearTimeout(timer); child?.kill(); server.close(); plugin.cleanup(); fs.rmSync(root,{recursive:true,force:true});
}
