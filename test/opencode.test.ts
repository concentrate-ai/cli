import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";

import { withStandalone } from "../src/lib/harnesses/opencode.js";
import { opencodeConfig } from "../src/lib/pickers.js";
import { runCn, tempDir } from "./helpers.js";

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
if (args[0] === "session" && args[1] === "list") { console.log(JSON.stringify([{ id: "ses_existing", title: "Existing conversation", directory: process.cwd(), updated: 1 }])); process.exit(0); }
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
  expect(runCn(["opencode"], { env }).status).toBe(0);
  expect(seen().args).toStrictEqual(["--standalone"]);
  runCn(["opencode", "--", "run", "say hi", "--format", "json"], { env });
  expect(seen().args).toStrictEqual([
    "run",
    "--standalone",
    "say hi",
    "--format",
    "json",
  ]);
  runCn(["opencode", "--", "--continue"], { env });
  expect(seen().args).toStrictEqual([
    "--standalone",
    "--session",
    "ses_existing",
  ]);
});

test("v1: the flag is never passed, because v1 rejects it", () => {
  const { env, seen } = rig("v1");
  expect(runCn(["opencode", "--", "run", "say hi"], { env }).status).toBe(0);
  expect(seen().args).toStrictEqual(["run", "say hi"]);
  runCn(["opencode"], { env });
  expect(seen().args).toStrictEqual([]);
});

test("v1 resume explicitly selects the Concentrate model instead of the session's former provider", () => {
  const { env, seen } = rig("v1");
  const result = runCn(
    ["opencode", "--model", "chosen", "resume", "ses_existing"],
    { env },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(seen().args).toStrictEqual([
    "--model",
    "concentrate/chosen",
    "--session",
    "ses_existing",
  ]);
});

test("both versions get native provider config, with the key by reference only", () => {
  for (const version of ["v1", "v2"]) {
    const { env, seen } = rig(version);
    runCn(["opencode", "--model", "claude-opus-4-6"], { env });
    const { config, key } = seen();
    const parsed = JSON.parse(config);
    expect(parsed.model).toBe("concentrate/claude-opus-4-6");
    const provider = (parsed.providers ?? parsed.provider).concentrate;
    expect(provider.package ?? provider.npm).toBe(
      version === "v2" ? "@opencode/ai/providers/openai" : "@ai-sdk/openai",
    );
    expect((provider.settings ?? provider.options).baseURL).toBe(
      "https://api.concentrate.ai/v1",
    );
    expect((provider.settings ?? provider.options).apiKey).toBe(
      "{env:CONCENTRATE_API_KEY}",
    );
    expect(
      provider.models["claude-opus-4-6"],
      "selected model is listed",
    ).toBeTruthy();
    expect(key).toBe("sk-test");
    expect(
      !config.includes("sk-test"),
      "the key is not written into the config",
    ).toBeTruthy();
  }
});

test("the config uses no v1-only model fields that v2 would warn about", () => {
  const config = opencodeConfig(
    "https://api.concentrate.ai",
    "m",
    [{ id: "m", name: "M", context: 1000, reasoning: true, image: true }],
    { modern: true },
  );
  expect(config.providers.concentrate.models.m).toStrictEqual({
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
  expect(withStandalone([])).toStrictEqual(["--standalone"]);
  expect(withStandalone(["run", "x"])).toStrictEqual([
    "run",
    "--standalone",
    "x",
  ]);
  expect(withStandalone(["-c"])).toStrictEqual(["--standalone", "-c"]);
});

test("doctor shows which OpenCode version is installed", () => {
  const v2 = runCn(["doctor"], { env: rig("v2").env });
  expect(v2.stdout).toMatch(/OpenCode\s+\S+opencode\s+opencode v2\.0\.20/);
  expect(runCn(["doctor"], { env: rig("v1").env }).stdout).toMatch(
    /OpenCode\s+\S+opencode\s+1\.19\.0/,
  );
});
