// Check installed tools with isolated state and dummy credentials. No paid calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { opencodeConfig, piConfig, writeCodexCatalog } from "../dist/lib/pickers.js";

const models = [
  { id: "cn-small-probe", name: "Small", context: 32768, output: 4096, image: false, chat_candidate: true, reasoning: false, reasoningSupport: false, efforts: [] },
  { id: "cn-large-probe", name: "Large", context: 400000, output: 64000, image: true, chat_candidate: true, reasoning: true, reasoningSupport: true, efforts: ["none", "low", "medium", "max"] },
];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-model-metadata-"));
const env = { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: path.join(dir, "config"), XDG_DATA_HOME: path.join(dir, "data"), XDG_CACHE_HOME: path.join(dir, "cache"), CODEX_HOME: path.join(dir, "codex"), CONCENTRATE_API_KEY: "sk-cn-probe", NO_COLOR: "1" };
for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CODEX_HOME"]) fs.mkdirSync(env[key], { recursive: true });

function command(binary, args, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: dir, env: { ...env, ...extra }, detached: true });
    child.stdin.end();
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGTERM"); } catch {} }, 25000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(dir, `${path.basename(binary)}.log`), stdout + stderr);
      if (code !== 0) reject(new Error(`${binary} exited ${code}; see ${dir}`));
      else resolve(stdout);
    });
  });
}

const target = process.argv[2] ?? "all";
console.log(`Artifacts: ${dir}`);
if (["all", "codex"].includes(target)) {
  const binary = process.env.CN_PROBE_CODEX_BIN ?? "codex";
  // The existing writer validates the file with Codex. This second read also
  // checks that the installed client preserved the advertised fields.
  const file = writeCodexCatalog(binary, models, path.join(dir, "models.json"), { env });
  const raw = await command(binary, ["-c", `model_catalog_json=${JSON.stringify(file)}`, "debug", "models"]);
  const catalog = JSON.parse(raw).models;
  for (const model of models) {
    const actual = catalog.find((entry) => entry.slug === model.id);
    assert.equal(actual?.context_window, model.context);
    assert.deepEqual(actual.input_modalities, model.image ? ["text", "image"] : ["text"]);
    assert.deepEqual(actual.supported_reasoning_levels.map((entry) => entry.effort), model.efforts);
  }
  console.log("Codex: installed catalog parser preserves distinct context, image, and reasoning metadata.");
}

if (["all", "pi"].includes(target)) {
  const root = process.env.CN_PROBE_PI_MODULES;
  assert.ok(root, "Set CN_PROBE_PI_MODULES to the installed directory containing @earendil-works");
  const moduleAt = (relative) => import(pathToFileURL(path.join(root, relative)));
  const { ModelConfig } = await moduleAt("@earendil-works/pi-coding-agent/dist/core/model-config.js");
  const { getSupportedThinkingLevels, clampThinkingLevel } = await moduleAt("@earendil-works/pi-ai/dist/models.js");
  const { streamSimple } = await moduleAt("@earendil-works/pi-ai/dist/api/openai-completions.js");
  const file = path.join(dir, "pi-models.json");
  fs.writeFileSync(file, JSON.stringify(piConfig("http://127.0.0.1:9", models)));
  const config = await ModelConfig.load(file);
  assert.equal(config.getError(), undefined);
  const entries = config.getProvider("concentrate").models;
  for (const definition of entries) {
    const expected = models.find((entry) => entry.id === definition.id);
    assert.equal(definition.contextWindow, expected.context);
    assert.equal(definition.maxTokens, expected.output);
    const model = { ...definition, api: "openai-completions", provider: "concentrate", baseUrl: "http://127.0.0.1:9/v1", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const levels = getSupportedThinkingLevels(model);
    assert.deepEqual(levels, model.reasoning ? ["off", "low", "medium", "max"] : ["off"]);
    let request;
    const stream = streamSimple(model, { messages: [{ role: "user", content: "Reply hello", timestamp: Date.now() }] }, {
      apiKey: "sk-cn-probe",
      reasoning: clampThinkingLevel(model, "high"),
      fetch: async (_url, init) => {
        request = JSON.parse(init.body);
        return new Response('data: {"id":"probe","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\ndata: {"id":"probe","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const result = await stream.result();
    assert.notEqual(result.stopReason, "error", result.errorMessage);
    assert.equal(request.model, model.id);
    assert.ok((request.max_tokens ?? request.max_completion_tokens) <= model.maxTokens);
    assert.ok((request.max_tokens ?? request.max_completion_tokens) > 0);
    if (model.reasoning) assert.ok(models[1].efforts.includes(request.reasoning_effort));
    else assert.equal(request.reasoning_effort, undefined);
  }
  console.log("Pi: installed schema, thinking choices, and outgoing output/effort fields verified.");
}

if (["all", "opencode"].includes(target)) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "probe", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const model of models) {
      const selected = model.reasoning ? `${model.id}#medium` : model.id;
      await command(process.env.CN_PROBE_OPENCODE_BIN ?? "opencode", ["run", "--standalone", "--print-logs", "--model", `concentrate/${selected}`, "Reply hello without tools"], {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(root, models[0].id, models, { modern: true })),
      });
      const actual = requests.findLast((entry) => entry.model === model.id);
      assert.ok(actual, `OpenCode did not request ${model.id}`);
      assert.ok((actual.max_tokens ?? actual.max_completion_tokens) > 0);
      assert.ok((actual.max_tokens ?? actual.max_completion_tokens) <= model.output);
      if (model.reasoning) assert.equal(actual.reasoning_effort, "medium");
      else assert.equal(actual.reasoning_effort, undefined);
    }
    fs.writeFileSync(path.join(dir, "opencode-requests.json"), JSON.stringify(requests, null, 2));
    console.log("OpenCode: real runs use each model's output limit and selected reasoning variant.");
  } finally {
    fs.writeFileSync(path.join(dir, "opencode-requests.json"), JSON.stringify(requests, null, 2));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
