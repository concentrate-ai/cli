// Real Claude Code, dummy key, isolated home, local slash commands only.
// No inference, user configuration, project content, or paid API requests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const { prepareClaudeContext } = await import(process.env.CN_PROBE_CONTEXT_MODULE || "../dist/lib/claude-context.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cn-context-switch-probe-"));
const available = [{ id: "cn-test-large", context: 400000 }, { id: "cn-test-small", context: 128000 }, { id: "claude-sonnet-4-6", context: 200000 }];
const plugin = prepareClaudeContext({ available });
const observer = path.join(root, "observer");
for (const name of ["home", "workspace", "observer/.claude-plugin", "observer/hooks"]) fs.mkdirSync(path.join(root, name), { recursive: true });
fs.writeFileSync(path.join(observer, ".claude-plugin/plugin.json"), JSON.stringify({ name: "cn-context-observer", version: "0.1.0" }));
fs.writeFileSync(path.join(observer, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.mjs"] }));
fs.writeFileSync(path.join(observer, "hooks/register.mjs"), `export function register(on) {
  on('session.start', async ($, e, next) => { await $.command.register({name:'cn-context-observe',description:'Read local context state'}); return next(e); });
  on('command.run', {command:'cn-context-observe'}, async ($) => ({text:JSON.stringify({ model:await $.session.model(), usage:await $.session.usage(), limit:await $.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS') })}));
}`);
const env = { PATH: process.env.PATH, HOME: path.join(root, "home"), CLAUDE_CONFIG_DIR: path.join(root, "home/.claude"),
  ANTHROPIC_API_KEY: "sk-local-context-probe", ANTHROPIC_BASE_URL: "http://127.0.0.1:9", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "400000",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1" };
const args = ["--plugin-dir", plugin.directory, "--plugin-dir", observer, "--model", "cn-test-large", "--settings", JSON.stringify({modelPicker:{replaceBuiltInOptions:true,options:available.map(m=>({model:m.id,label:m.id}))}}), "--no-session-persistence", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "-p"];
const commands = ["/cn-context-observe", "/model cn-test-small", "/cn-context-observe", "/model cn-test-large", "/cn-context-observe", "/model claude-sonnet-4-6", "/cn-context-observe", "/model cn-test-small", "/cn-context-observe"];
const child = spawn(process.env.CN_PROBE_CLAUDE_BIN || "claude", args, { cwd: path.join(root, "workspace"), env, stdio: ["pipe", "pipe", "pipe"] });
let index = 0, buffer = "", errors = "";
const observations = [];
const failures = [];
const timer = setTimeout(() => child.kill("SIGTERM"), 20000);
function send() {
  if (index === commands.length) { child.stdin.end(); return; }
  child.stdin.write(JSON.stringify({type:"user",message:{role:"user",content:commands[index++]}}) + "\n");
}
child.stderr.on("data", (d) => { errors += d; });
child.stdout.on("data", (d) => {
  buffer += d;
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    let item; try { item = JSON.parse(line); } catch { continue; }
    if (item.type !== "result") continue;
    if (process.env.CN_PROBE_DEBUG) console.error(item.result);
    if (item.is_error) failures.push(item.result);
    if (item.duration_api_ms !== 0 || item.total_cost_usd !== 0) failures.push("Expected zero inference calls and cost");
    if (item.result?.includes("cn-context-observer: ")) {
      try { observations.push(JSON.parse(item.result.slice(item.result.indexOf("{", item.result.indexOf("cn-context-observer: "))))); }
      catch (error) { failures.push(error.message); }
    }
    send();
  }
});
send();
try {
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  assert.equal(code, 0, errors);
  assert.deepEqual(failures, []);
  assert.deepEqual(observations.map(o=>[o.model,o.usage.context.window,o.limit]), [
    ["cn-test-large",400000,"400000"], ["cn-test-small",128000,"128000"], ["cn-test-large",400000,"400000"], ["claude-sonnet-4-6",200000,undefined], ["cn-test-small",128000,"128000"],
  ]);
  console.log(JSON.stringify({claude:process.env.CN_PROBE_CLAUDE_BIN || "claude",observations:observations.map(o=>({model:o.model,window:o.usage.context.window,override:o.limit??null})),inferenceCalls:0,passed:true},null,2));
} finally {
  clearTimeout(timer);
  child.kill();
  plugin.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
}
