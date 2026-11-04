import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import {
  appHeaders,
  codexHeaderConfig,
  openCodeHeaders,
} from "../src/lib/app-headers.js";
import { tempDir } from "./helpers.js";
import codex from "../src/lib/harnesses/codex.js";
import pi from "../src/lib/harnesses/pi.js";
import opencode from "../src/lib/harnesses/opencode.js";

test("header names are case-insensitive, values and unrelated headers survive", () => {
  expect(
    appHeaders("pi", { "X-App": "old", Other: "yes" }, { "x-APP": "custom" }),
  ).toStrictEqual({ Other: "yes", "x-APP": "custom" });
  expect(appHeaders("pi")).toStrictEqual({ "X-App": "pi" });
});

test("Codex respects CLI overrides and environment-supplied X-App", () => {
  const dir = tempDir("cn-header-codex-");
  const env = { CODEX_HOME: dir };
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    '[model_providers.concentrate.env_http_headers]\n"x-app"="APP_NAME"\n',
  );
  expect(codexHeaderConfig("concentrate", env).http_headers).toStrictEqual({});
  expect(
    codexHeaderConfig("concentrate", env, [
      "-c",
      'model_providers.concentrate.http_headers={"x-aPP"="explicit"}',
    ]).http_headers,
  ).toStrictEqual({ "x-aPP": "explicit" });
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
    expect(openCodeHeaders(env, modern)).toStrictEqual({
      Other: "keep",
      "X-APP": "inline",
    });
    expect(openCodeHeaders(env, modern, false)).toStrictEqual({
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
  expect(
    prepared.args.includes(
      'model_providers.concentrate.http_headers={"X-App"="codex"}',
    ),
  ).toBeTruthy();
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
    expect(doc.providers.concentrate.headers).toStrictEqual({
      "x-app": "custom-pi",
    });
  } finally {
    launched.cleanup();
  }
  const opened = await opencode.prepare({
    ...input,
    executable: "/usr/bin/false",
  });
  expect(
    JSON.parse(opened.env.OPENCODE_CONFIG_CONTENT).provider.concentrate.options
      .headers["X-App"],
  ).toBe("opencode");
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
  expect(
    prepared.args.indexOf('model_provider="concentrate"') < subcommand,
  ).toBeTruthy();
  expect(
    prepared.args.indexOf(
      'model_providers.concentrate.http_headers={"x-app"="custom"}',
    ) < subcommand,
  ).toBeTruthy();
  expect(prepared.args.slice(subcommand)).toStrictEqual(["exec", "Reply OK"]);
  prepared.cleanup();
});

test("Pi keeps the user's MCP config and other files but never their login", async () => {
  const root = tempDir("cn-pi-carry-");
  fs.writeFileSync(path.join(root, "mcp.json"), '{"mcpServers":{"a":{}}}');
  fs.writeFileSync(path.join(root, "auth.json"), '{"token":"secret"}');
  fs.mkdirSync(path.join(root, "extensions"));
  const launched = await pi.prepare({
    executable: process.execPath,
    model: "test",
    key: "sk-test",
    available: [],
    forwarded: [],
    env: { HOME: root, PI_CODING_AGENT_DIR: root, CN_CONFIG_HOME: root },
  });
  try {
    const dir = launched.env.PI_CODING_AGENT_DIR;
    expect(fs.readFileSync(path.join(dir, "mcp.json"), "utf8")).toBe(
      '{"mcpServers":{"a":{}}}',
    );
    expect(fs.existsSync(path.join(dir, "extensions"))).toBeTruthy();
    expect(fs.existsSync(path.join(dir, "auth.json"))).toBe(false);
  } finally {
    launched.cleanup();
  }
});
