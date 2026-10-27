// Manual installed-client test; synthetic credentials, isolated state, localhost responses only.
// Optional: CN_PROBE_CODEX_BIN and CN_PROBE_DAEMON_BIN select the frontend and backend releases.
// Resume installed clients through a localhost mock using synthetic keys and isolated homes.
// Run after npm run build; optionally pass codex, pi, or opencode to limit the probe.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexRpc } from "../dist/lib/codex-daemon.js";
import { localSessions } from "../dist/lib/sessions.js";
import { getHarness } from "../dist/lib/harnesses/registry.js";
import { resolveSessionArgs } from "../dist/lib/sessions.js";
import { piConfig, opencodeConfig } from "../dist/lib/pickers.js";
const root = fs.mkdtempSync("/tmp/cn-handoff-");
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

const dir = path.join(root, "work");
fs.mkdirSync(dir);
process.chdir(dir);
const env = {
  PATH: process.env.PATH,
  HOME: root,
  CODEX_HOME: path.join(root, "cx"),
  CN_CONFIG_HOME: path.join(root, "cn"),
  ORIGINAL_API_KEY: "sk-original-probe",
  CN_OFFLINE: "1",
  NO_COLOR: "1",
  TERM: "xterm-256color",
};
fs.mkdirSync(env.CODEX_HOME, { recursive: true });
const overrides = [
  'model_provider="original"',
  'model_providers.original.name="Original"',
  `model_providers.original.base_url="${api}/v1"`,
  'model_providers.original.env_key="ORIGINAL_API_KEY"',
  'model_providers.original.wire_api="responses"',
  "model_providers.original.requires_openai_auth=false",
  'web_search="disabled"',
];
fs.writeFileSync(
  path.join(env.CODEX_HOME, "config.toml"),
  overrides.join("\n") +
    "\n[projects." +
    JSON.stringify(dir) +
    ']\ntrust_level="trusted"\n',
);
await run(
  "codex",
  [
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
const session = localSessions("codex", env, process.cwd(), undefined, {
  includeNonInteractive: true,
})[0];
assert.ok(session);
const socket = path.join(
  env.CODEX_HOME,
  "app-server-control",
  "app-server-control.sock",
);
fs.mkdirSync(path.dirname(socket));
const daemon = spawn(
  process.env.CN_PROBE_DAEMON_BIN || binaries.codex,
  ["app-server", "--listen", "unix://" + socket],
  { env, cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
);
let daemonLog = "";
daemon.stdout.on("data", (x) => (daemonLog += x));
daemon.stderr.on("data", (x) => (daemonLog += x));
let prepared;
try {
  for (let n = 0; n < 100 && !fs.existsSync(socket); n++)
    await new Promise((r) => setTimeout(r, 50));
  const initial = await CodexRpc.connect(socket);
  const loaded = await initial.request("thread/resume", {
    threadId: session.id,
    excludeTurns: true,
  });
  assert.equal(loaded.modelProvider, "original");
  initial.close();
  await new Promise((r) => setTimeout(r, 200));
  const before = requests.length;
  prepared = await getHarness("codex").prepare({
    executable: binaries.codex,
    model: model.id,
    key: "sk-cn-handoff-probe",
    available: [model],
    forwarded: [
      "-c",
      `model_providers.concentrate.base_url="${api}/v1"`,
      "resume",
      session.id,
      "Continue without tools.",
    ],
    env,
  });
  assert.ok(
    prepared.args.includes("--remote"),
    "No same-server handoff selected",
  );
  prepared.cleanup();
  prepared = undefined;
  const config = path.join(root, "tui.json");
  const args = [
    fileURLToPath(new URL("../dist/bin/cn.js", import.meta.url)),
    "codex",
    "--model",
    model.id,
    "resume",
    session.id,
    "-c",
    `model_providers.concentrate.base_url=\"${api}/v1\"`,
    "Continue without tools.",
  ];
  fs.writeFileSync(
    config,
    JSON.stringify({
      binary: process.execPath,
      args,
      cwd: dir,
      env: { ...env, CONCENTRATE_API_KEY: "sk-cn-handoff-probe" },
    }),
  );
  await new Promise((resolve, reject) =>
    execFile(
      "python3",
      [
        fileURLToPath(
          new URL("./fixtures/codex-handoff-terminal.py", import.meta.url),
        ),
        config,
      ],
      { timeout: 40000 },
      (error, stdout, stderr) =>
        error ? reject(new Error(stdout + " " + stderr)) : resolve(stdout),
    ),
  );
  fs.writeFileSync(
    path.join(root, "requests.json"),
    JSON.stringify(requests, null, 2),
  );
  const resumed = requests
    .slice(before)
    .filter((r) => JSON.stringify(r.body).includes("Continue without tools."));
  assert.ok(resumed.length, "No resumed request");
  for (const r of resumed) {
    assert.equal(r.key, "Bearer sk-cn-handoff-probe");
  }
  assert.ok(
    resumed.some((r) =>
      JSON.stringify(r.body).includes("SESSION_HISTORY_MARKER"),
    ),
    "No main conversation request with saved history",
  );
  const reader = await CodexRpc.connect(socket);
  const info = await reader.request("thread/read", {
    threadId: session.id,
    includeTurns: false,
  });
  reader.close();
  assert.equal(info.thread.id, session.id);
  console.log(
    "PASS: interactive CLI -> retained server -> cn resume; same ID and saved history, Concentrate credential",
  );
} finally {
  prepared?.cleanup();
  if (daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await new Promise((r) => daemon.once("close", r));
  }
  fs.writeFileSync(path.join(root, "daemon.log"), daemonLog);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
