import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";

import { withStandalone } from "../../src/lib/harnesses/opencode.js";
import { opencodeConfig } from "../../src/lib/harnesses/pickers.js";
import { runCn, setup } from "../helpers.js";

// Stand-in OpenCode. FAKE_OC=v2 makes --help advertise --standalone, as the real v2 does.
function rig(version) {
  const { bin, env } = setup({ FAKE_OC: version });
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

const endpoint = {
  baseURL: "https://api.concentrate.ai/v1",
  apiKey: "{env:CONCENTRATE_API_KEY}",
};
const selected = { "claude-opus-4-6": expect.any(Object) };

test.each([
  [
    "v1",
    {
      provider: {
        concentrate: {
          npm: "@ai-sdk/openai",
          options: endpoint,
          models: selected,
        },
      },
    },
  ],
  [
    "v2",
    {
      providers: {
        concentrate: {
          package: "@opencode/ai/providers/openai",
          settings: endpoint,
          models: selected,
        },
      },
    },
  ],
])(
  "both versions get native provider config, with the key by reference only: %s",
  (version, expected) => {
    const { env, seen } = rig(version);
    runCn(["opencode", "--model", "claude-opus-4-6"], { env });
    const { config, key } = seen();
    expect(JSON.parse(config)).toMatchObject({
      model: "concentrate/claude-opus-4-6",
      ...expected,
    });
    expect(key).toBe("sk-test");
    expect(config, "the key is not written into the config").not.toContain(
      "sk-test",
    );
  },
);

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
