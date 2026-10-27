// Resume installed clients through a localhost mock using synthetic keys and isolated homes.
// Run after npm run build; optionally pass codex, pi, or opencode to limit the probe.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { getHarness } from "../dist/lib/harnesses/registry.js";
import { resolveSessionArgs } from "../dist/lib/sessions.js";
import { piConfig, opencodeConfig } from "../dist/lib/pickers.js";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cn-all-resume-"));
console.log("Artifacts: " + root);
const binaries = {
  codex: process.env.CN_PROBE_CODEX_BIN || "codex",
  pi: process.env.CN_PROBE_PI_BIN || "pi",
  opencode: process.env.CN_PROBE_OPENCODE_BIN || "opencode",
};
const model = {
  id: "gpt-5.5",
  name: "Resume probe",
  context: 128000,
  output: 4096,
  reasoning: false,
  image: false,
  claude: true,
  codex: true,
  chat_candidate: true,
};
const requests = [];
const server = http.createServer(async (req, res) => {
  let text = "";
  for await (const part of req) text += part;
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {}
  if (!body.model) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
    return;
  }
  requests.push({ url: req.url, key: req.headers.authorization, body });
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (req.url.includes("responses")) {
    const item = {
      id: "msg_probe",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "PROBE_REPLY", annotations: [] }],
    };
    const response = {
      id: "resp_probe",
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: body.model,
      status: "completed",
      output: [item],
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        total_tokens: 25,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    for (const event of [
      {
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: "PROBE_REPLY",
      },
      {
        type: "response.output_text.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: "PROBE_REPLY",
      },
      {
        type: "response.content_part.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: item.content[0],
      },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ])
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  } else {
    for (const chunk of [
      {
        id: "chat_probe",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "PROBE_REPLY" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chat_probe",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
    ])
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write("data: [DONE]\n\n");
  }
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const api = `http://127.0.0.1:${server.address().port}`;
async function run(id, args, env, cwd, label) {
  return await new Promise((resolve, reject) => {
    const child = spawn(binaries[id], args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    let output = "";
    child.stdout.on("data", (p) => (output += p));
    child.stderr.on("data", (p) => (output += p));
    const timer = setTimeout(() => child.kill("SIGKILL"), 35000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(cwd, label + ".log"), output);
      code === 0
        ? resolve(output)
        : reject(
            new Error(`${id} ${label} exited ${code}; ${cwd}/${label}.log`),
          );
    });
  });
}
const originalCwd = process.cwd();
try {
  for (const id of process.argv.slice(2).length
    ? process.argv.slice(2)
    : ["codex", "pi", "opencode"]) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir);
    process.chdir(dir);
    const env = {
      PATH: process.env.PATH,
      HOME: dir,
      CODEX_HOME: path.join(dir, "codex"),
      PI_CODING_AGENT_DIR: path.join(dir, "pi"),
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_DATA_HOME: path.join(dir, "data"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
      CN_CONFIG_HOME: path.join(dir, "cn"),
      ORIGINAL_API_KEY: "sk-original-probe",
      CONCENTRATE_API_KEY: "sk-cn-probe",
      PI_OFFLINE: "1",
      NO_COLOR: "1",
      CN_OFFLINE: "1",
    };
    fs.mkdirSync(env.CODEX_HOME, { recursive: true });
    fs.mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
    if (id === "codex") {
      const overrides = [
        'model_provider="original"',
        'model_providers.original.name="Original"',
        `model_providers.original.base_url="${api}/v1"`,
        'model_providers.original.env_key="ORIGINAL_API_KEY"',
        'model_providers.original.wire_api="responses"',
        "model_providers.original.requires_openai_auth=false",
        'web_search="disabled"',
      ];
      await run(
        id,
        [
          ...overrides.flatMap((x) => ["-c", x]),
          "-m",
          model.id,
          "exec",
          "--skip-git-repo-check",
          "--json",
          "Remember SESSION_HISTORY_MARKER.",
        ],
        env,
        dir,
        "original",
      );
    } else if (id === "pi") {
      const provider = piConfig(api, [model]).providers.concentrate;
      provider.apiKey = "$ORIGINAL_API_KEY";
      fs.writeFileSync(
        path.join(env.PI_CODING_AGENT_DIR, "models.json"),
        JSON.stringify({ providers: { original: provider } }),
      );
      await run(
        id,
        [
          "--provider",
          "original",
          "--model",
          model.id,
          "--offline",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-context-files",
          "-p",
          "Remember SESSION_HISTORY_MARKER.",
        ],
        env,
        dir,
        "original",
      );
    } else {
      const config = opencodeConfig(api, model.id, [model], { modern: true });
      config.providers.original = config.providers.concentrate;
      delete config.providers.concentrate;
      config.model = "original/" + model.id;
      config.providers.original.settings.apiKey = "{env:ORIGINAL_API_KEY}";
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
      await run(
        id,
        [
          "run",
          "--standalone",
          "--model",
          "original/" + model.id,
          "Remember SESSION_HISTORY_MARKER.",
        ],
        env,
        dir,
        "original",
      );
    }
    const before = requests.length;
    const forwarded =
      id === "codex" ? ["exec", "resume", "--last"] : ["--continue"];
    const resolved = await resolveSessionArgs(id, binaries[id], forwarded, env);
    assert.ok(resolved, "No session resolved");
    let replay;
    if (id === "codex")
      replay = [
        ...resolved,
        "--skip-git-repo-check",
        "--json",
        "Continue without tools.",
      ];
    else if (id === "pi")
      replay = [
        ...resolved,
        "--offline",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "-p",
        "Continue without tools.",
      ];
    else replay = ["run", ...resolved, "Continue without tools."];
    const prepared = await getHarness(id).prepare({
      executable: binaries[id],
      model: model.id,
      key: "sk-cn-probe",
      available: [model],
      forwarded: replay,
      env,
    });
    try {
      let args = prepared.args.map((x) =>
        x.replaceAll("https://api.concentrate.ai/v1", api + "/v1"),
      );
      const childEnv = { ...env, ...prepared.env };
      if (id === "pi") {
        const file = path.join(childEnv.PI_CODING_AGENT_DIR, "models.json");
        const config = JSON.parse(fs.readFileSync(file));
        config.providers.concentrate.baseUrl = api + "/v1";
        fs.writeFileSync(file, JSON.stringify(config));
      }
      if (id === "opencode")
        childEnv.OPENCODE_CONFIG_CONTENT =
          childEnv.OPENCODE_CONFIG_CONTENT.replaceAll(
            "https://api.concentrate.ai/v1",
            api + "/v1",
          );
      await run(id, args, childEnv, dir, "resumed");
      const resumed = requests
        .slice(before)
        .filter((r) =>
          JSON.stringify(r.body).includes("Continue without tools."),
        );
      fs.writeFileSync(
        path.join(dir, "request-summary.json"),
        JSON.stringify(requests.slice(before), null, 2),
      );
      assert.ok(resumed.length, "No resumed model request");
      for (const request of resumed) {
        assert.ok(
          JSON.stringify(request.body).includes("SESSION_HISTORY_MARKER"),
          "Missing saved user message",
        );
        assert.ok(
          JSON.stringify(request.body).includes("PROBE_REPLY"),
          "Missing saved assistant reply",
        );
        assert.equal(
          request.key,
          "Bearer sk-cn-probe",
          "Previous provider credential retained",
        );
      }
      console.log(id + ": saved history replayed with Concentrate key");
    } finally {
      prepared.cleanup();
    }
  }
} finally {
  process.chdir(originalCwd);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
