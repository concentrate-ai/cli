import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BIN = fileURLToPath(new URL("../dist/bin/cn.js", import.meta.url));
export const CODEX_TEMPLATE = {
  slug: "gpt-5.5",
  shell_type: "unified_exec",
  context_window: 272000,
  truncation_policy: { mode: "tokens", limit: 12000 },
  base_instructions: "Bundled coding instructions",
  model_messages: {
    instructions_template:
      "You are a coding agent based on GPT-5.5. Use the tools.",
  },
  future_catalog_field: { preserved: true },
};

export function tempDir(prefix = "cn-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A stand-in tool that records argv and selected env vars, then exits with `exitCode`.
export function fakeTool(directory, name, { exitCode = 0 } = {}) {
  const record = path.join(directory, `${name}.record.json`);
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
// Minimal offline stand-in for the plugin install protocol observed in Claude 2.1.308.
if (${JSON.stringify(name)} === "claude" && process.argv[2] === "plugin" && process.argv[3] === "install") {
  const market = process.argv[process.argv.indexOf("--marketplace") + 1];
  const pluginRoot = path.join(process.env.CLAUDE_CONFIG_DIR, "plugins");
  const installPath = path.join(pluginRoot, "cache", "concentrate-cn", "cn-context", "0.1.0");
  fs.mkdirSync(installPath, { recursive: true });
  fs.cpSync(path.join(market, "context"), installPath, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "cn-context@concentrate-cn": [{ scope: "user", installPath, version: "0.1.0" }] } }));
  fs.writeFileSync(path.join(pluginRoot, "known_marketplaces.json"), JSON.stringify({ "concentrate-cn": { source: { source: "directory", path: market }, installLocation: market } }));
  console.log(JSON.stringify({ outcome: "ok" }));
  process.exit(0);
}
if (${JSON.stringify(name)} === "codex" && process.argv[2] === "--help") {
  console.log("      --no-daemon");
  process.exit(0);
}
if (${JSON.stringify(name)} === "codex" && process.argv.includes("--bundled")) {
  console.log(JSON.stringify({ models: [${JSON.stringify(CODEX_TEMPLATE)}] }));
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  args: process.argv.slice(2),
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ANTHROPIC_|CONCENTRATE_|PI_CODING|CN_CLAUDE|CLAUDE_CODE_AUTO_MODE_MODEL$|CLAUDE_CODE_MAX_CONTEXT_TOKENS$)/.test(k))),
}));
process.exit(${exitCode});
`;
  const file = path.join(directory, name);
  fs.writeFileSync(file, script, { mode: 0o755 });
  return () => JSON.parse(fs.readFileSync(record, "utf8"));
}

export function runCn(args, { env = {}, input } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    input,
    env: {
      PATH: path.dirname(process.execPath),
      HOME: os.homedir(),
      CN_OFFLINE: "1",
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
