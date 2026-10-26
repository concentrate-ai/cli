// Read native configuration with installed clients in an isolated home. No inference.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile, spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const { configureTool, resetTool, toolConfigPaths } = await import(
  process.env.CN_PROBE_TOOL_CONFIG_MODULE || "../dist/lib/tool-config.js"
);
import { writeJson, writeKey, writePreferences } from "../dist/lib/settings.js";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cn-native-client-probe-"));
const env = {
  PATH: process.env.PATH,
  HOME: root,
  CN_CONFIG_HOME: path.join(root, "cn"),
  CODEX_HOME: path.join(root, "codex"),
  CLAUDE_CONFIG_DIR: path.join(root, "claude"),
  PI_CODING_AGENT_DIR: path.join(root, "pi"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  CN_OFFLINE: "1",
  NO_COLOR: "1",
};
const models = [
  {
    id: "cn-native-small",
    name: "Small",
    context: 32768,
    output: 4096,
    image: false,
    claude: true,
    codex: true,
    chat_candidate: true,
    reasoning: true,
    reasoningSupport: true,
    efforts: ["low", "medium", "high"],
  },
  {
    id: "cn-native-large",
    name: "Large",
    context: 128000,
    output: 8192,
    image: true,
    claude: true,
    codex: true,
    chat_candidate: true,
    reasoning: true,
    reasoningSupport: true,
    efforts: ["low", "medium", "high"],
  },
];
writeKey("sk-cn-native-probe", env);
writePreferences(
  Object.fromEntries(
    ["claude", "codex", "opencode", "pi"].map((id) => [id, models[0].id]),
  ),
  env,
);
writeJson(path.join(env.CN_CONFIG_HOME, "catalog.json"), {
  version: 3,
  fetched_at: Date.now(),
  models,
});
const command = (binary, args) => {
  const out = spawnSync(binary, args, {
    env,
    cwd: root,
    encoding: "utf8",
    timeout: 20000,
  });
  if (out.status !== 0)
    throw new Error(`${path.basename(binary)} failed: ${out.stderr}`);
  return out.stdout;
};
console.log(`Isolated artifacts: ${root}`);
await configureTool("codex", env);
const actual = JSON.parse(
  command(process.env.CN_PROBE_CODEX_BIN || "codex", ["debug", "models"]),
);
for (const model of models) {
  const entry = actual.models.find((entry) => entry.slug === model.id);
  assert.equal(entry.context_window, model.context);
  assert.deepEqual(
    entry.supported_reasoning_levels.map((level) => level.effort),
    model.efforts,
  );
}
console.log(
  "Codex: native config and command-backed auth schema accepted; model windows and effort choices preserved.",
);
await configureTool("opencode", env);
const requests = [];
const mock = http.createServer(async (request, response) => {
  let body = "";
  for await (const part of request) body += part;
  const data = JSON.parse(body || "{}");
  if (!data.model) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [] }));
    return;
  }
  requests.push({
    authorization: request.headers.authorization,
    url: request.url,
    data,
  });
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    'data: {"id":"probe","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\ndata: {"id":"probe","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  );
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
try {
  const file = toolConfigPaths("opencode", env).settings;
  const config = JSON.parse(fs.readFileSync(file));
  config.providers.concentrate.settings.baseURL = `http://127.0.0.1:${mock.address().port}/v1`;
  fs.writeFileSync(file, JSON.stringify(config));
  await new Promise((resolve, reject) => {
    const child = execFile(
      process.env.CN_PROBE_OPENCODE_BIN || "opencode",
      [
        "run",
        "--standalone",
        "--model",
        `concentrate/${models[0].id}`,
        "Reply hello without tools",
      ],
      { env, cwd: root, timeout: 25000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin.end();
  });
  fs.writeFileSync(
    path.join(root, "request-fields.json"),
    JSON.stringify(
      requests.map(({ url, data }) => ({
        url,
        ...Object.fromEntries(
          Object.entries(data).filter(
            ([, value]) => value === null || typeof value !== "object",
          ),
        ),
      })),
      null,
      2,
    ),
  );
  const actual = requests.find(
    (entry) =>
      entry.data.model === models[0].id &&
      (entry.data.max_tokens ?? entry.data.max_completion_tokens) > 0,
  );
  assert.ok(actual, `No capped model request; see ${root}/request-fields.json`);
  assert.equal(actual.authorization, "Bearer sk-cn-native-probe");
  assert.ok(
    (actual.data.max_tokens ?? actual.data.max_completion_tokens) <=
      models[0].output,
  );
  console.log(
    "OpenCode: native config, private credential file, and output cap verified against a localhost mock.",
  );
} finally {
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
}
await configureTool("pi", env);
const modules = process.env.CN_PROBE_PI_MODULES;
assert.ok(modules, "CN_PROBE_PI_MODULES is required");
const { ModelConfig } = await import(
  pathToFileURL(
    path.join(
      modules,
      "@earendil-works/pi-coding-agent/dist/core/model-config.js",
    ),
  )
);
const config = await ModelConfig.load(toolConfigPaths("pi", env).catalog);
assert.equal(config.getError(), undefined);
for (const model of models) {
  const entry = config
    .getProvider("concentrate")
    .models.find((entry) => entry.id === model.id);
  assert.equal(entry.contextWindow, model.context);
  assert.equal(entry.maxTokens, model.output);
}
console.log(
  "Pi: native model configuration accepted with distinct context/output limits.",
);
await configureTool("claude", env);
const helper = toolConfigPaths("claude", env).helper;
assert.equal(command(helper, []).trim(), "sk-cn-native-probe");
// The observer only reads state. Claude must load the installed capability plugin from its native registry.
const observer = path.join(root, "observer");
fs.mkdirSync(path.join(observer, ".claude-plugin"), { recursive: true });
fs.mkdirSync(path.join(observer, "hooks"));
fs.writeFileSync(
  path.join(observer, ".claude-plugin/plugin.json"),
  JSON.stringify({ name: "cn-native-observer", version: "0.1.0" }),
);
fs.writeFileSync(
  path.join(observer, "hooks/hooks.json"),
  JSON.stringify({ modules: ["./register.mjs"] }),
);
fs.writeFileSync(
  path.join(observer, "hooks/register.mjs"),
  `export function register(on) {
  on('session.start', async ($, e, next) => { await $.command.register({name:'cn-native-observe',description:'Read local context state'}); return next(e); });
  on('command.run', {command:'cn-native-observe'}, async ($) => ({text:JSON.stringify({model:await $.session.model(),usage:await $.session.usage(),output:await $.env.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS")})}));
}`,
);
const commands = [
  "/cn-native-observe",
  `/model ${models[1].id}`,
  "/cn-native-observe",
  `/model ${models[0].id}`,
  "/cn-native-observe",
];
const child = spawn(
  process.env.CN_PROBE_CLAUDE_BIN || "claude",
  [
    "--plugin-dir",
    observer,
    "--settings",
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" } }),
    "--no-session-persistence",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "-p",
  ],
  {
    cwd: root,
    env: {
      ...env,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
    },
  },
);
const observed = [],
  results = [],
  failures = [];
let index = 0,
  buffer = "",
  stderr = "";
const send = () =>
  index === commands.length
    ? child.stdin.end()
    : child.stdin.write(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: commands[index++] },
        }) + "\n",
      );
child.stderr.on("data", (data) => {
  stderr += data;
});
child.stdout.on("data", (data) => {
  buffer += data;
  for (;;) {
    const at = buffer.indexOf("\n");
    if (at < 0) break;
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "result") continue;
    results.push(entry);
    if (entry.is_error || entry.duration_api_ms > 0 || entry.total_cost_usd > 0)
      failures.push(entry.result);
    if (entry.result?.includes("cn-native-observer"))
      observed.push(
        JSON.parse(
          entry.result.slice(
            entry.result.indexOf(
              "{",
              entry.result.indexOf("cn-native-observer"),
            ),
          ),
        ),
      );
    send();
  }
});
const timeout = setTimeout(() => child.kill("SIGTERM"), 20000);
send();
try {
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(code, 0, stderr);
  fs.writeFileSync(
    path.join(root, "claude-results.json"),
    JSON.stringify({ results, stderr }, null, 2),
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(
    observed.map((entry) => [entry.model, entry.usage.context.window]),
    [
      [models[0].id, models[0].context],
      [models[1].id, models[1].context],
      [models[0].id, models[0].context],
    ],
  );
  assert.deepEqual(
    observed.map((entry) => Number(entry.output)),
    [models[0].output, models[1].output, models[0].output],
  );
  console.log(
    "Claude: native default and per-model context windows verified across switches; read-only observer, zero inference calls.",
  );
} finally {
  clearTimeout(timeout);
  child.kill();
}

for (const id of ["claude", "codex", "opencode", "pi"])
  assert.equal(resetTool(id, env).reset, true);
console.log("Reset: all four integrations restored successfully.");
