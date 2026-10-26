import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { summarize } from "../dist/lib/catalog.js";
import { writeJson, writePreferences } from "../dist/lib/settings.js";
import { fakeTool, tempDir } from "./helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("source install produces a self-contained CLI and launches all four adapters", () => {
  const dir = tempDir("cn-ts-install-");
  const home = path.join(dir, "home with spaces");
  const data = path.join(dir, "runtime $data");
  const bin = path.join(dir, "tools");
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_DATA_HOME: data,
    CN_CONFIG_HOME: path.join(dir, "config"),
    CN_OFFLINE: "1",
    CONCENTRATE_API_KEY: "sk-test",
    PI_CODING_AGENT_DIR: path.join(dir, "pi"),
  };
  const installed = spawnSync("bash", [path.join(root, "install.sh")], {
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(installed.status, 0, installed.stderr);
  const runtime = path.join(data, "concentrate-cli");
  assert.equal(fs.existsSync(path.join(runtime, "node_modules")), false);
  assert.equal(fs.existsSync(path.join(runtime, "src")), false);
  assert.equal(
    fs.existsSync(path.join(runtime, "dist/lib/claude-context/register.mjs")),
    true,
  );
  const cn = path.join(home, ".local/bin/cn");
  const run = (args) =>
    spawnSync(cn, args, { env, encoding: "utf8", timeout: 10000 });
  assert.equal(run(["--version"]).stdout.trim(), "0.1.0");
  assert.match(run(["--help"]).stdout, /claude, codex, opencode, pi/);
  const models = ["small", "large"].map((id) =>
    summarize({
      id,
      name: id,
      max_input_tokens: 32768,
      max_tokens: 4096,
      integrations: {
        claude_code: { supported: true },
        codex: { supported: true },
      },
      providers: {
        a: {
          supports: {
            input: { text: true },
            tools: { function_calling: true },
          },
        },
      },
    }),
  );
  writeJson(path.join(env.CN_CONFIG_HOME, "catalog.json"), {
    version: 3,
    fetchedAt: Date.now() / 1000,
    models,
  });
  writePreferences(
    { claude: "small", codex: "small", opencode: "small", pi: "small" },
    env,
  );
  for (const name of ["claude", "codex", "opencode", "pi"]) {
    const record = fakeTool(bin, name);
    const result = run([name]);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.ok(record().args.length || name === "opencode");
  }
});
