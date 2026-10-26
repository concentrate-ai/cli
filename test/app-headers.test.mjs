import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  appHeaders,
  codexHeaders,
  openCodeHeaders,
} from "../dist/lib/app-headers.js";
import { tempDir } from "./helpers.mjs";
import codex from "../dist/lib/harnesses/codex.js";
import pi from "../dist/lib/harnesses/pi.js";
import opencode from "../dist/lib/harnesses/opencode.js";

test("header names are case-insensitive, values and unrelated headers survive", () => {
  assert.deepEqual(
    appHeaders("pi", { "X-App": "old", Other: "yes" }, { "x-APP": "custom" }),
    { Other: "yes", "x-APP": "custom" },
  );
  assert.deepEqual(appHeaders("pi"), { "X-App": "pi" });
});

test("Codex respects CLI overrides and environment-supplied X-App", () => {
  const dir = tempDir("cn-header-codex-");
  const env = { CODEX_HOME: dir };
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    '[model_providers.concentrate.env_http_headers]\n"x-app"="APP_NAME"\n',
  );
  assert.deepEqual(codexHeaders("concentrate", env), {});
  assert.deepEqual(
    codexHeaders("concentrate", env, [
      "-c",
      'model_providers.concentrate.http_headers={"x-aPP"="explicit"}',
    ]),
    { "x-aPP": "explicit" },
  );
});

for (const modern of [false, true])
  test(`OpenCode ${modern ? "v2" : "v1"} keeps configured and inline headers`, () => {
    const dir = tempDir("cn-header-opencode-");
    const provider = (headers) =>
      modern
        ? { providers: { concentrate: { headers } } }
        : { provider: { concentrate: { options: { headers } } } };
    const file = path.join(dir, "opencode.jsonc");
    fs.writeFileSync(
      file,
      "// comment\n" +
        JSON.stringify(provider({ "x-App": "saved", Other: "keep" })),
    );
    const env = {
      HOME: dir,
      OPENCODE_CONFIG: file,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(provider({ "X-APP": "inline" })),
    };
    assert.deepEqual(openCodeHeaders(env, modern), {
      Other: "keep",
      "X-APP": "inline",
    });
    assert.deepEqual(openCodeHeaders(env, modern, false), {
      "x-App": "saved",
      Other: "keep",
    });
  });

test("launch adapters add X-App and preserve existing Pi provider headers", async () => {
  const root = tempDir("cn-header-launch-");
  const env = {
    HOME: root,
    CODEX_HOME: path.join(root, "codex"),
    PI_CODING_AGENT_DIR: root,
    CN_CONFIG_HOME: root,
    XDG_CONFIG_HOME: root,
  };
  const input = {
    executable: process.execPath,
    model: "test",
    key: "sk-test",
    available: [],
    forwarded: ["--no-session"],
    env,
  };
  const prepared = await codex.prepare({ ...input, forwarded: [] });
  assert.ok(
    prepared.args.includes(
      'model_providers.concentrate.http_headers={"X-App"="codex"}',
    ),
  );
  prepared.cleanup();
  fs.writeFileSync(
    path.join(root, "models.json"),
    JSON.stringify({
      providers: { concentrate: { headers: { "x-app": "custom-pi" } } },
    }),
  );
  const launched = await pi.prepare(input);
  try {
    const doc = JSON.parse(
      fs.readFileSync(
        path.join(launched.env.PI_CODING_AGENT_DIR, "models.json"),
      ),
    );
    assert.deepEqual(doc.providers.concentrate.headers, {
      "x-app": "custom-pi",
    });
  } finally {
    launched.cleanup();
  }
  const opened = await opencode.prepare({
    ...input,
    executable: "/usr/bin/false",
  });
  assert.equal(
    JSON.parse(opened.env.OPENCODE_CONFIG_CONTENT).provider.concentrate.options
      .headers["X-App"],
    "opencode",
  );
});

test("Codex keeps subcommand config overrides beside its connection options", async () => {
  const root = tempDir("cn-header-subcommand-");
  const prepared = await codex.prepare({
    executable: process.execPath,
    model: "test",
    key: "sk-test",
    available: [],
    forwarded: [
      "exec",
      "-c",
      'model_providers.concentrate.http_headers={"x-app"="custom"}',
      "Reply OK",
    ],
    env: { HOME: root },
  });
  const subcommand = prepared.args.indexOf("exec");
  assert.ok(prepared.args.indexOf('model_provider="concentrate"') < subcommand);
  assert.ok(
    prepared.args.indexOf(
      'model_providers.concentrate.http_headers={"x-app"="custom"}',
    ) < subcommand,
  );
  assert.deepEqual(prepared.args.slice(subcommand), ["exec", "Reply OK"]);
  prepared.cleanup();
});
