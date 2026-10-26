import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { launch } from "../dist/lib/launch.js";
import { readPreferences, writeJson } from "../dist/lib/settings.js";
import { tempDir } from "./helpers.mjs";

const CATALOG = [
  {
    id: "claude-sonnet-4-6",
    name: "Sonnet",
    claude: true,
    codex: true,
    chat_candidate: true,
  },
  {
    id: "claude-opus-4-6",
    name: "Opus",
    claude: true,
    codex: true,
    chat_candidate: true,
  },
];

function rig({ catalog = true } = {}) {
  const bin = tempDir("cn-bin-");
  const config = tempDir("cn-cfg-");
  const claudeHome = tempDir("cn-claude-");
  const codexHome = tempDir("cn-codex-");
  if (catalog)
    writeJson(path.join(config, "catalog.json"), {
      version: 3,
      fetchedAt: Date.now() / 1000,
      models: CATALOG,
    });
  const env = {
    PATH: `${bin}:${path.dirname(process.execPath)}`,
    CN_CONFIG_HOME: config,
    CONCENTRATE_API_KEY: "sk-test",
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
  };
  const tool = (name, body) =>
    fs.writeFileSync(
      path.join(bin, name),
      `#!/usr/bin/env node\nconst fs = require("node:fs"), path = require("node:path");\nconst argv = process.argv.slice(2);\nconst opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };\n${body}\n`,
      { mode: 0o755 },
    );
  const saved = (id) => readPreferences({ CN_CONFIG_HOME: config })[id];
  const configWritten = () => fs.existsSync(path.join(config, "config.json"));
  // In-process, as an interactive session: the only kind where a user switches models.
  const run = (id, opts = {}) =>
    launch(id, { tty: true, forwarded: [], ...opts }, env);
  return {
    bin,
    config,
    claudeHome,
    codexHome,
    env,
    tool,
    saved,
    configWritten,
    run,
  };
}

// Like the real Claude: writes <session-id>.jsonl under projects/<encoded cwd>/.
const claudeWrites = (home, ...models) => `
const id = opt("--session-id") || "unpinned";
const dir = path.join(${JSON.stringify(home)}, "projects", "-some-encoded-cwd");
fs.mkdirSync(dir, { recursive: true });
const rows = ${JSON.stringify(models)}.map((model) => JSON.stringify({ type: "assistant", message: { model } }));
fs.writeFileSync(path.join(dir, id + ".jsonl"), ['{"type":"user"}', ...rows].join("\\n") + "\\n");`;

test("claude: a model switched inside the tool is remembered for next time", async () => {
  const r = rig();
  r.tool(
    "claude",
    claudeWrites(r.claudeHome, "claude-sonnet-4-6", "claude-opus-4-6"),
  );
  assert.equal(await r.run("claude"), 0);
  assert.equal(r.saved("claude"), "claude-opus-4-6");
});

test("claude: another session writing in the same folder at the same time is not mistaken for this one", async () => {
  const r = rig();
  r.tool(
    "claude",
    `${claudeWrites(r.claudeHome, "claude-sonnet-4-6")}
fs.writeFileSync(path.join(${JSON.stringify(r.claudeHome)}, "projects", "-some-encoded-cwd", "someone-else.jsonl"),
  JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-6" } }) + "\\n");`,
  );
  await r.run("claude");
  assert.equal(r.configWritten(), false);
});

test("claude: staying on the launch model, or an unknown model, changes nothing", async () => {
  for (const model of ["claude-sonnet-4-6", "some-unlisted-model"]) {
    const r = rig();
    r.tool("claude", claudeWrites(r.claudeHome, model));
    await r.run("claude");
    assert.equal(r.configWritten(), false, model);
  }
});

test("claude: a provider prefix is stripped and synthetic entries are skipped", async () => {
  const r = rig();
  r.tool(
    "claude",
    claudeWrites(r.claudeHome, "anthropic/claude-opus-4-6", "<synthetic>"),
  );
  await r.run("claude");
  assert.equal(r.saved("claude"), "claude-opus-4-6");
});

test("nothing is remembered for scripted runs, one-off model flags, resumed sessions, or without a catalog", async () => {
  const cases = [
    ["not a terminal", { tty: false }],
    ["model passed to the tool", { forwarded: ["--model", "claude-opus-4-6"] }],
    ["model passed as --model=", { forwarded: ["--model=claude-opus-4-6"] }],
    ["resumed session", { forwarded: ["--continue"] }],
  ];
  for (const [label, opts] of cases) {
    const r = rig();
    r.tool("claude", claudeWrites(r.claudeHome, "claude-opus-4-6"));
    await r.run("claude", opts);
    assert.equal(r.configWritten(), false, label);
  }
  const offline = rig({ catalog: false });
  offline.tool("claude", claudeWrites(offline.claudeHome, "claude-opus-4-6"));
  await launch("claude", { tty: true }, { ...offline.env, CN_OFFLINE: "1" });
  assert.equal(offline.configWritten(), false, "no catalog");
});

test("the remembered model is what the next launch starts on", async () => {
  const r = rig();
  r.tool("claude", claudeWrites(r.claudeHome, "claude-opus-4-6"));
  await r.run("claude");
  r.tool(
    "claude",
    `fs.writeFileSync(${JSON.stringify(path.join(r.bin, "args.json"))}, JSON.stringify(argv));`,
  );
  await r.run("claude");
  const args = JSON.parse(
    fs.readFileSync(path.join(r.bin, "args.json"), "utf8"),
  );
  assert.equal(args[args.indexOf("--model") + 1], "claude-opus-4-6");
});

test("a failure while remembering never replaces the tool's exit code", async () => {
  const r = rig();
  r.tool(
    "claude",
    `${claudeWrites(r.claudeHome, "claude-opus-4-6")}\nfs.writeFileSync(${JSON.stringify(path.join(r.config, "config.json"))}, "{}", { mode: 0o644 });\nprocess.exit(7);`,
  );
  assert.equal(await r.run("claude", { model: "claude-sonnet-4-6" }), 7);
});

test("a FIFO where a transcript should be does not hang cn", async () => {
  const r = rig();
  r.tool(
    "claude",
    `
const dir = path.join(${JSON.stringify(r.claudeHome)}, "projects", "-cwd");
fs.mkdirSync(dir, { recursive: true });
require("node:child_process").execFileSync("/usr/bin/mkfifo", [path.join(dir, opt("--session-id") + ".jsonl")]);`,
  );
  assert.equal(await r.run("claude"), 0);
  assert.equal(r.configWritten(), false);
});

// Like the real Pi: writes <time>_<session-id>.jsonl in --session-dir.
const piWrites = (provider, ...models) => `
const dir = opt("--session-dir"), id = opt("--session-id") || "unpinned";
if (dir) {
  const change = (modelId) => JSON.stringify({ type: "model_change", provider: ${JSON.stringify(provider)}, modelId });
  fs.writeFileSync(path.join(dir, "2026-10-13T19-12-53-933Z_" + id + ".jsonl"),
    [JSON.stringify({ type: "session" }), ...${JSON.stringify(models)}.map(change)].join("\\n") + "\\n");
}`;

test("pi: a model switched inside Pi is remembered from its pinned session", async () => {
  const r = rig();
  r.tool(
    "pi",
    piWrites("concentrate", "deepseek-v4-1-flash", "claude-opus-4-6"),
  );
  await r.run("pi");
  assert.equal(r.saved("pi"), "claude-opus-4-6");
});

test("pi: the model of the last reply counts when there was no explicit switch entry", async () => {
  const r = rig();
  r.tool(
    "pi",
    `
fs.writeFileSync(path.join(opt("--session-dir"), "t_" + opt("--session-id") + ".jsonl"),
  JSON.stringify({ type: "message", message: { role: "assistant", provider: "concentrate", model: "claude-opus-4-6" } }) + "\\n");`,
  );
  await r.run("pi");
  assert.equal(r.saved("pi"), "claude-opus-4-6");
});

test("pi: another provider, --no-session, and --session-dir=<dir> are handled", async () => {
  const other = rig();
  other.tool("pi", piWrites("other", "claude-opus-4-6"));
  await other.run("pi");
  assert.equal(other.configWritten(), false, "another provider");

  const ephemeral = rig();
  ephemeral.tool("pi", piWrites("concentrate", "claude-opus-4-6"));
  await ephemeral.run("pi", { forwarded: ["--no-session"] });
  assert.equal(ephemeral.configWritten(), false, "--no-session");

  const own = rig();
  const dir = tempDir("cn-own-sessions-");
  own.tool(
    "pi",
    `fs.writeFileSync(${JSON.stringify(path.join(own.bin, "args.json"))}, JSON.stringify(argv));\n${piWrites("concentrate", "claude-opus-4-6")}`,
  );
  await own.run("pi", { forwarded: [`--session-dir=${dir}`] });
  const args = JSON.parse(
    fs.readFileSync(path.join(own.bin, "args.json"), "utf8"),
  );
  assert.equal(
    args.filter((a) => a.startsWith("--session-dir")).length,
    1,
    "no second --session-dir",
  );
});

test("pi: a failure while preparing removes the temporary directory", async () => {
  const r = rig();
  r.tool("pi", "");
  fs.writeFileSync(path.join(r.config, "pi-sessions"), "not a directory");
  const os = await import("node:os");
  const before = new Set(
    fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("cn-pi-")),
  );
  await assert.rejects(r.run("pi"));
  const left = fs
    .readdirSync(os.tmpdir())
    .filter((n) => n.startsWith("cn-pi-") && !before.has(n));
  assert.deepEqual(left, []);
});

// Like the real Codex: a dated rollout file whose first line is a session_meta header.
const codexWrites = (
  home,
  { cwd = "process.cwd()", provider = "concentrate", name = "rollout-1" } = {},
  ...models
) => `
const d = new Date(), two = (n) => String(n).padStart(2, "0");
const dir = path.join(${JSON.stringify(home)}, "sessions", String(d.getFullYear()), two(d.getMonth() + 1), two(d.getDate()));
fs.mkdirSync(dir, { recursive: true });
const meta = JSON.stringify({ type: "session_meta", payload: { cwd: fs.realpathSync(${cwd}), model_provider: ${JSON.stringify(provider)} } });
const turn = (model) => JSON.stringify({ type: "turn_context", payload: { model } });
fs.writeFileSync(path.join(dir, ${JSON.stringify(name)} + ".jsonl"), [meta, ...${JSON.stringify(models)}.map(turn)].join("\\n") + "\\n");`;

test("codex: the model from this run's session is remembered", async () => {
  const r = rig();
  r.tool(
    "codex",
    codexWrites(r.codexHome, {}, "deepseek-v4-1-flash", "claude-opus-4-6"),
  );
  await r.run("codex");
  assert.equal(r.saved("codex"), "claude-opus-4-6");
});

test("codex: sessions from another directory or provider are ignored", async () => {
  const elsewhere = rig();
  elsewhere.tool(
    "codex",
    codexWrites(
      elsewhere.codexHome,
      { cwd: JSON.stringify(path.dirname(process.cwd())) },
      "claude-opus-4-6",
    ),
  );
  await elsewhere.run("codex");
  assert.equal(elsewhere.configWritten(), false, "other directory");

  const provider = rig();
  provider.tool(
    "codex",
    codexWrites(provider.codexHome, { provider: "openai" }, "claude-opus-4-6"),
  );
  await provider.run("codex");
  assert.equal(provider.configWritten(), false, "other provider");
});
