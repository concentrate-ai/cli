import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { withStandalone } from "../dist/lib/harnesses/opencode.js";
import { opencodeConfig } from "../dist/lib/pickers.js";
import { runCn, tempDir } from "./helpers.mjs";

// Stand-in OpenCode. FAKE_OC=v2 makes --help advertise --standalone, as the real v2 does.
function rig(version) {
  const bin = tempDir("cn-bin-");
  const config = tempDir("cn-cfg-");
  const record = path.join(bin, "record.json");
  fs.writeFileSync(
    path.join(bin, "opencode"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--help") { console.log(process.env.FAKE_OC === "v2" ? "FLAGS\\n  --standalone  Run with a private server" : "Commands:\\n  opencode run"); process.exit(0); }
if (args[0] === "--version") { console.log(process.env.FAKE_OC === "v2" ? "opencode v2.0.20" : "1.19.0"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, config: process.env.OPENCODE_CONFIG_CONTENT, key: process.env.CONCENTRATE_API_KEY }));
`,
    { mode: 0o755 },
  );
  const env = {
    PATH: `${bin}:${path.dirname(process.execPath)}`,
    CN_CONFIG_HOME: config,
    CONCENTRATE_API_KEY: "sk-test",
    FAKE_OC: version,
  };
  return { env, seen: () => JSON.parse(fs.readFileSync(record, "utf8")) };
}

test("v2: the private-server flag is added, after the subcommand when there is one", () => {
  const { env, seen } = rig("v2");
  assert.equal(runCn(["opencode"], { env }).status, 0);
  assert.deepEqual(seen().args, ["--standalone"]);
  runCn(["opencode", "--", "run", "say hi", "--format", "json"], { env });
  assert.deepEqual(seen().args, [
    "run",
    "--standalone",
    "say hi",
    "--format",
    "json",
  ]);
  runCn(["opencode", "--", "--continue"], { env });
  assert.deepEqual(seen().args, ["--standalone", "--continue"]);
});

test("v1: the flag is never passed, because v1 rejects it", () => {
  const { env, seen } = rig("v1");
  assert.equal(runCn(["opencode", "--", "run", "say hi"], { env }).status, 0);
  assert.deepEqual(seen().args, ["run", "say hi"]);
  runCn(["opencode"], { env });
  assert.deepEqual(seen().args, []);
});

test("both versions get native provider config, with the key by reference only", () => {
  for (const version of ["v1", "v2"]) {
    const { env, seen } = rig(version);
    runCn(["opencode", "--model", "claude-opus-4-6"], { env });
    const { config, key } = seen();
    const parsed = JSON.parse(config);
    assert.equal(parsed.model, "concentrate/claude-opus-4-6");
    const provider = (parsed.providers ?? parsed.provider).concentrate;
    assert.equal(
      provider.package ?? provider.npm,
      version === "v2"
        ? "@opencode/ai/providers/openai-compatible"
        : "@ai-sdk/openai-compatible",
    );
    assert.equal(
      (provider.settings ?? provider.options).baseURL,
      "https://api.concentrate.ai/v1",
    );
    assert.equal(
      (provider.settings ?? provider.options).apiKey,
      "{env:CONCENTRATE_API_KEY}",
    );
    assert.ok(provider.models["claude-opus-4-6"], "selected model is listed");
    assert.equal(key, "sk-test");
    assert.ok(
      !config.includes("sk-test"),
      "the key is not written into the config",
    );
  }
});

test("the config uses no v1-only model fields that v2 would warn about", () => {
  const config = opencodeConfig(
    "https://api.concentrate.ai",
    "m",
    [{ id: "m", name: "M", context: 1000, reasoning: true, image: true }],
    { modern: true },
  );
  assert.deepEqual(config.providers.concentrate.models.m, {
    name: "M",
    limit: { context: 1000 },
    capabilities: {
      input: ["text", "image"],
      output: ["text"],
      reasoning: { supported: true },
    },
  });
});

test("withStandalone keeps argument order", () => {
  assert.deepEqual(withStandalone([]), ["--standalone"]);
  assert.deepEqual(withStandalone(["run", "x"]), ["run", "--standalone", "x"]);
  assert.deepEqual(withStandalone(["-c"]), ["--standalone", "-c"]);
});

test("doctor shows which OpenCode version is installed", () => {
  const v2 = runCn(["doctor"], { env: rig("v2").env });
  assert.match(v2.stdout, /OpenCode\s+\S+opencode\s+opencode v2\.0\.20/);
  assert.match(
    runCn(["doctor"], { env: rig("v1").env }).stdout,
    /OpenCode\s+\S+opencode\s+1\.19\.0/,
  );
});
