import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";

import {
  parseFlags,
  parseLaunchArgs,
  parseHarnessLaunchArgs,
} from "../src/lib/cli.js";
import { fakeTool, runCn, tempDir } from "./helpers.js";
import { modelsFor } from "../src/lib/catalog.js";
import { which } from "../src/lib/launch.js";
import { writeCodexCatalog } from "../src/lib/pickers.js";

function setup(extraEnv = {}) {
  const bin = tempDir("cn-bin-");
  const config = tempDir("cn-cfg-");
  const nodeDir = path.dirname(process.execPath);
  return {
    bin,
    config,
    env: {
      PATH: `${bin}:${nodeDir}`,
      CN_CONFIG_HOME: config,
      CONCENTRATE_API_KEY: "sk-test",
      // Never read the developer's real Codex config.
      CODEX_HOME: tempDir("cn-codex-home-"),
      ...extraEnv,
    },
  };
}

test("Claude session aliases preserve IDs, native flags, model overrides, and literal prompts", () => {
  expect(
    parseHarnessLaunchArgs("claude", ["resume", "saved-session"]),
  ).toStrictEqual({
    model: undefined,
    forwarded: ["--resume", "saved-session"],
  });
  expect(
    parseHarnessLaunchArgs("claude", ["continue"]).forwarded,
  ).toStrictEqual(["--continue"]);
  expect(parseHarnessLaunchArgs("claude", ["resume"]).forwarded).toStrictEqual([
    "--resume",
  ]);
  expect(
    parseHarnessLaunchArgs("claude", [
      "--model",
      "claude-sonnet-5",
      "resume",
      "saved-session",
    ]),
  ).toStrictEqual({
    model: "claude-sonnet-5",
    forwarded: ["--resume", "saved-session"],
  });
  expect(
    parseHarnessLaunchArgs("claude", ["--", "resume"]).forwarded,
  ).toStrictEqual(["resume"]);
  expect(
    parseHarnessLaunchArgs("claude", [
      "resume",
      "saved-session",
      "--",
      "continue",
    ]).forwarded,
  ).toStrictEqual(["--resume", "saved-session", "--", "continue"]);
  expect(
    parseHarnessLaunchArgs("claude", ["--resume", "saved-session"]).forwarded,
  ).toStrictEqual(["--resume", "saved-session"]);
  expect(
    parseHarnessLaunchArgs("codex", ["resume", "saved-session"]).forwarded,
  ).toStrictEqual(["resume", "saved-session"]);
});

test.each([
  [
    ["resume", "saved-session"],
    ["--resume", "saved-session"],
  ],
  [["resume"], ["--resume"]],
  [["continue"], ["--continue"]],
  [
    ["--resume", "saved-session"],
    ["--resume", "saved-session"],
  ],
  [["--continue"], ["--continue"]],
])(
  "Claude resume uses Concentrate without assigning a new session or changing saved login: %j",
  (args, forwarded) => {
    const directory = tempDir("cn-existing-claude-");
    const login = path.join(directory, ".credentials.json");
    const original =
      '{"claudeAiOauth":{"accessToken":"synthetic-subscription-token"}}';
    fs.writeFileSync(login, original);
    const { bin, env } = setup({ CLAUDE_CONFIG_DIR: directory });
    const record = fakeTool(bin, "claude");
    const result = runCn(["claude", ...args], { env });
    expect(result.status, result.stderr).toBe(0);
    const seen = record();
    expect(seen.args.includes("--session-id")).toBe(false);
    expect(seen.args.slice(-args.length)).toStrictEqual(forwarded);
    expect(seen.env.ANTHROPIC_BASE_URL).toBe("https://api.concentrate.ai");
    expect(seen.env.CN_CLAUDE_KEY).toBe("sk-test");
    expect(fs.readFileSync(login, "utf8")).toBe(original);
  },
);

test("a missing tool fails fast with exit 127, an install hint, and no key or network needed", () => {
  const { bin, env } = setup({ CONCENTRATE_API_KEY: "" });
  // Node's own directory can also contain globally installed coding agents.
  env.PATH = bin;
  const result = runCn(["codex"], { env });
  expect(result.status).toBe(127);
  expect(result.stderr).toMatch(/Codex CLI isn't installed/);
  expect(result.stderr).toMatch(/npm install -g @openai\/codex/);
  expect(result.stderr).not.toMatch(/Usage:/);
  expect(result.stderr).not.toMatch(/API key/);
});

test("an installed tool with no key tells the user to run setup", () => {
  const { bin, env } = setup({ CONCENTRATE_API_KEY: "" });
  fakeTool(bin, "claude");
  const result = runCn(["claude"], { env });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Run cn setup first/);
});

test("claude gets Concentrate in its child environment and forwards args after --", () => {
  const { bin, env } = setup();
  const record = fakeTool(bin, "claude");
  const result = runCn(
    ["claude", "--model", "claude-opus-4-6", "--", "-p", "hello"],
    { env },
  );
  expect(result.status, result.stderr).toBe(0);
  const seen = record();
  expect(seen.env.ANTHROPIC_BASE_URL).toBe("https://api.concentrate.ai");
  expect(seen.env.CN_CLAUDE_KEY).toBe("sk-test");
  expect(
    seen.env.ANTHROPIC_API_KEY,
    "the key reaches Claude only through cn's helper",
  ).toBe(undefined);
  expect(seen.env.ANTHROPIC_MODEL).toBe("claude-opus-4-6");
  expect(seen.args.slice(0, 1)).toStrictEqual(["--settings"]);
  expect(seen.args[seen.args.indexOf("--model") + 1]).toBe("claude-opus-4-6");
  expect(seen.args.slice(-2)).toStrictEqual(["-p", "hello"]);
  const settings = JSON.parse(seen.args[1]);
  expect(settings.env.ANTHROPIC_MODEL).toBe("claude-opus-4-6");
  expect(settings.apiKeyHelper).toBe("printenv CN_CLAUDE_KEY");
  expect(
    settings.env,
    "credentials are blanked over the user's own settings files",
  ).toMatchObject({
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    CLAUDE_CODE_USE_BEDROCK: "",
  });
  expect(seen.args.join(" "), "key must never appear in argv").not.toContain(
    "sk-test",
  );
});

test.each([
  "glm-5.3",
  "glm-5.3-flash",
  "zai/glm-5.3",
  "gpt-6-luna",
  "openai/gpt-6-luna",
])(
  "claude launches non-Claude models with the same classifier, including provider-pinned models: %s",
  (model) => {
    const { bin, env } = setup();
    const record = fakeTool(bin, "claude");
    const result = runCn(["claude", "--model", model], { env });
    expect(result.status, result.stderr).toBe(0);
    const seen = record();
    expect(seen.env.ANTHROPIC_MODEL).toBe(model);
    expect(seen.env.CLAUDE_CODE_AUTO_MODE_MODEL).toBe(model);
    expect(JSON.parse(seen.args[1]).env.CLAUDE_CODE_AUTO_MODE_MODEL).toBe(
      model,
    );
  },
);

test("claude preserves an explicit classifier choice when launching a non-Claude model", () => {
  const { bin, env } = setup({
    CLAUDE_CODE_AUTO_MODE_MODEL: "claude-sonnet-5",
  });
  const record = fakeTool(bin, "claude");
  const result = runCn(["claude", "--model", "glm-5.3"], { env });
  expect(result.status, result.stderr).toBe(0);
  const seen = record();
  expect(seen.env.CLAUDE_CODE_AUTO_MODE_MODEL).toBe("claude-sonnet-5");
  expect(JSON.parse(seen.args[1]).env.CLAUDE_CODE_AUTO_MODE_MODEL).toBe(
    "claude-sonnet-5",
  );
});

test("claude leaves classifier selection alone for Claude models", () => {
  const { bin, env } = setup();
  const record = fakeTool(bin, "claude");
  const result = runCn(["claude", "--model", "claude-sonnet-5"], { env });
  expect(result.status, result.stderr).toBe(0);
  const seen = record();
  expect(seen.env.CLAUDE_CODE_AUTO_MODE_MODEL).toBe(undefined);
  expect(JSON.parse(seen.args[1]).env.CLAUDE_CODE_AUTO_MODE_MODEL).toBe(
    undefined,
  );
});

test.each(["glm-5.3", "zai/glm-5.3"])(
  "claude receives catalog context limits for custom and provider-pinned model IDs: %s",
  (model) => {
    const { bin, config, env } = setup();
    const record = fakeTool(bin, "claude");
    fs.writeFileSync(
      path.join(config, "catalog.json"),
      JSON.stringify({
        version: 6,
        fetchedAt: Date.now() / 1000,
        models: [{ id: "glm-5.3", name: "GLM", claude: true, context: 202752 }],
      }),
      { mode: 0o600 },
    );
    const result = runCn(["claude", "--model", model], { env });
    expect(result.status, result.stderr).toBe(0);
    const seen = record();
    expect(seen.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("202752");
    expect(
      JSON.parse(seen.args[1]).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
      "automatic limit must not be pinned in settings across switches",
    ).toBe(undefined);
  },
);

test("claude respects a user's explicit context limit instead of the catalog", () => {
  const { bin, config, env } = setup({
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "100000",
  });
  const record = fakeTool(bin, "claude");
  fs.writeFileSync(
    path.join(config, "catalog.json"),
    JSON.stringify({
      version: 6,
      fetchedAt: Date.now() / 1000,
      models: [{ id: "glm-5.3", name: "GLM", claude: true, context: 202752 }],
    }),
    { mode: 0o600 },
  );
  const result = runCn(["claude", "--model", "glm-5.3"], { env });
  expect(result.status, result.stderr).toBe(0);
  const seen = record();
  expect(seen.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("100000");
  expect(JSON.parse(seen.args[1]).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(
    "100000",
  );
});

test.each(["unknown-model", "claude-sonnet-5"])(
  "claude gets no invented context limit for missing metadata or native Claude IDs: %s",
  (model) => {
    const { bin, config, env } = setup();
    const record = fakeTool(bin, "claude");
    fs.writeFileSync(
      path.join(config, "catalog.json"),
      JSON.stringify({
        version: 6,
        fetchedAt: Date.now() / 1000,
        models: [
          {
            id: "claude-sonnet-5",
            name: "Sonnet",
            claude: true,
            context: 1000000,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const result = runCn(["claude", "--model", model], { env });
    expect(result.status, result.stderr).toBe(0);
    const seen = record();
    expect(seen.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(undefined);
    expect(JSON.parse(seen.args[1]).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(
      undefined,
    );
  },
);

const codingModels = Array.from({ length: 133 }, (_, i) => ({
  id: `coding-model-${i}`,
  name: `Coding Model ${i}`,
  claude: true,
}));
const codingPickerOptions = codingModels.map((model) =>
  expect.objectContaining({ model: model.id }),
);

test("claude's picker includes every compatible model beyond the former shortlist", () => {
  const { bin, config, env } = setup();
  const record = fakeTool(bin, "claude");
  fs.writeFileSync(
    path.join(config, "catalog.json"),
    JSON.stringify({
      version: 6,
      fetchedAt: Date.now() / 1000,
      models: [
        ...codingModels,
        { id: "unsupported-model", name: "Unsupported", claude: false },
      ],
    }),
    { mode: 0o600 },
  );
  const result = runCn(["claude", "--model", "coding-model-132"], { env });
  expect(result.status, result.stderr).toBe(0);
  const { modelPicker } = JSON.parse(record().args[1]);
  expect(modelPicker.options.length).toBe(133);
  expect(modelPicker.options[0].model).toBe("coding-model-132");
  expect(modelPicker.options).toEqual(
    expect.arrayContaining(codingPickerOptions),
  );
});

test("codex gets per-run provider overrides and the key only in env", () => {
  const { bin, env } = setup();
  const record = fakeTool(bin, "codex");
  const result = runCn(["codex", "--", "exec", "hi"], { env });
  expect(result.status, result.stderr).toBe(0);
  const seen = record();
  expect(seen.env.CONCENTRATE_API_KEY).toBe("sk-test");
  const joined = seen.args.join("\n");
  expect(joined).toMatch(/model_provider="concentrate"/);
  expect(joined).toMatch(/model_catalog_json=/);
  expect(joined).toMatch(
    /model_providers\.concentrate\.base_url="https:\/\/api\.concentrate\.ai\/v1"/,
  );
  expect(joined).toMatch(
    /model_providers\.concentrate\.env_key="CONCENTRATE_API_KEY"/,
  );
  expect(joined).not.toContain("sk-test");
  expect(seen.args[seen.args.indexOf("-m") + 1]).toBe("gpt-6.1-terra");
  expect(seen.args.slice(-2)).toStrictEqual(["exec", "hi"]);
});

test("codex omits env_key when the saved provider already has a credential helper", () => {
  const codexHome = tempDir("cn-codex-home-");
  const { bin, env } = setup({ CODEX_HOME: codexHome });
  const record = fakeTool(bin, "codex");
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    '[model_providers.concentrate.auth]\ncommand = "/tmp/helper"\n',
  );
  expect(runCn(["codex", "--", "exec", "hi"], { env }).status).toBe(0);
  expect(record().args.join("\n")).not.toContain("env_key");
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "x"\n');
  expect(runCn(["codex", "--", "exec", "hi"], { env }).status).toBe(0);
  expect(record().args.join("\n")).toMatch(/env_key="CONCENTRATE_API_KEY"/);
});

test("codex runs without the shared background server", () => {
  const { bin, env } = setup();
  const record = fakeTool(bin, "codex");
  const result = runCn(["codex", "--", "exec", "hi"], { env });
  expect(result.status, result.stderr).toBe(0);
  expect(record().args).toContain("--no-daemon");
});

test("codex is limited to OpenAI models", async () => {
  const models = [
    { id: "gpt-5.5", codex: true, chat_candidate: true },
    { id: "o3", codex: true, chat_candidate: true },
    { id: "gpt-oss-120b", codex: true, chat_candidate: true },
    { id: "grok-4.7", codex: true, chat_candidate: true },
    { id: "gemini-3.8-flash", codex: true, chat_candidate: true },
  ];
  expect(modelsFor("codex", models)).toMatchObject([
    { id: "gpt-5.5" },
    { id: "o3" },
  ]);
});

test("a saved non-OpenAI Codex default falls back, and --model refuses one", () => {
  const { bin, env } = setup();
  const record = fakeTool(bin, "codex");
  fs.writeFileSync(
    path.join(env.CN_CONFIG_HOME, "config.json"),
    JSON.stringify({ models: { codex: "grok-4.7" } }),
    { mode: 0o600 },
  );
  const result = runCn(["codex", "--", "exec", "hi"], { env });
  expect(result.status, result.stderr).toBe(0);
  const { args } = record();
  expect(args[args.indexOf("-m") + 1]).toBe("gpt-6.1-terra");
  const refused = runCn(["codex", "--model", "grok-4.7"], { env });
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toMatch(/limited to OpenAI models/);
});

test("codex resumes directly with the original session ID and Concentrate settings", () => {
  const { bin, env } = setup({ CODEX_HOME: tempDir("cn-codex-home-") });
  const record = fakeTool(bin, "codex");
  const session = "01a1830a-36f8-76c0-acb6-e82b2183af2b";
  const result = runCn(["codex", "resume", session], { env });
  expect(result.status, result.stderr).toBe(0);
  const seen = record();
  expect(seen.args.slice(-2)).toStrictEqual(["resume", session]);
  expect(seen.args.includes("--remote")).toBe(false);
  expect(seen.args.join("\n")).toMatch(/model_provider="concentrate"/);
  expect(seen.env.CONCENTRATE_API_KEY).toBe("sk-test");
});

test("pi runs against a temporary agent dir that is removed afterwards", () => {
  const { bin, env } = setup();
  const record = fakeTool(bin, "pi");
  const result = runCn(["pi", "--", "-p", "hi"], { env });
  expect(result.status, result.stderr).toBe(0);
  const seen = record();
  expect(seen.args.slice(0, 4)).toStrictEqual([
    "--provider",
    "concentrate",
    "--model",
    "deepseek-v4-1-flash",
  ]);
  expect(seen.args.includes("--session-dir")).toBe(false);
  expect(seen.args.includes("--session-id")).toBe(false);
  expect(seen.env.PI_CODING_AGENT_DIR).toMatch(/cn-pi-/);
  expect(
    fs.existsSync(seen.env.PI_CODING_AGENT_DIR),
    "temp dir should be cleaned up",
  ).toBe(false);
  expect(seen.args.slice(-2)).toStrictEqual(["-p", "hi"]);
});

test("pi refuses versions before 0.77 and asks for an update", () => {
  const { bin, env } = setup();
  fakeTool(bin, "pi", { version: "0.76.2", versionOnStderr: true });
  const result = runCn(["pi", "--", "-p", "hi"], { env });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/Pi 0\.77 or newer/);
  expect(result.stderr).toMatch(/pi update self/);
  expect(fs.existsSync(path.join(bin, "pi.record.json"))).toBe(false);
});

test.each(["0.77.0", "0.87.1", "1.0.0"])(
  "pi launches on 0.77 and later: %s",
  (version) => {
    const { bin, env } = setup();
    const record = fakeTool(bin, "pi", { version });
    const result = runCn(["pi", "--", "-p", "hi"], { env });
    expect(result.status, result.stderr).toBe(0);
    expect(record().args.slice(-2)).toStrictEqual(["-p", "hi"]);
  },
);

test("pi keeps the user's settings and never copies auth.json", () => {
  const { bin, env } = setup();
  const source = tempDir("cn-pi-src-");
  fs.writeFileSync(path.join(source, "settings.json"), '{"theme":"dark"}');
  fs.writeFileSync(path.join(source, "auth.json"), '{"secret":"nope"}');
  const probe = path.join(bin, "pi");
  fs.writeFileSync(
    probe,
    `#!/usr/bin/env node
const fs = require("node:fs"), p = require("node:path");
const d = process.env.PI_CODING_AGENT_DIR;
console.log(JSON.stringify({ settings: JSON.parse(fs.readFileSync(p.join(d, "settings.json"), "utf8")), hasAuth: fs.existsSync(p.join(d, "auth.json")) }));
`,
    { mode: 0o755 },
  );
  const result = runCn(["pi"], {
    env: { ...env, PI_CODING_AGENT_DIR: source },
  });
  const out = JSON.parse(result.stdout);
  expect(out.settings.theme).toBe("dark");
  expect(out.settings.defaultProvider).toBe("concentrate");
  expect(out.hasAuth).toBe(false);
});

test("the tool's exit code is propagated", () => {
  const { bin, env } = setup();
  fakeTool(bin, "claude", { exitCode: 7 });
  expect(runCn(["claude"], { env }).status).toBe(7);
});

test("argument parsing", () => {
  expect(parseLaunchArgs([])).toStrictEqual({
    model: undefined,
    forwarded: [],
  });
  expect(parseLaunchArgs(["--model", "m", "--", "-p", "x"])).toStrictEqual({
    model: "m",
    forwarded: ["-p", "x"],
  });
  expect(parseLaunchArgs(["--model=m"])).toStrictEqual({
    model: "m",
    forwarded: [],
  });
  expect(parseLaunchArgs(["-p", "x"])).toStrictEqual({
    model: undefined,
    forwarded: ["-p", "x"],
  });
  expect(() => parseLaunchArgs(["--model"])).toThrow(/needs a model ID/);
  expect(() => parseFlags(["--nope"])).toThrow(/Unknown option/);
  expect(
    parseFlags(["claude", "--search", "x"], { values: ["search"] }),
  ).toStrictEqual({
    flags: { search: "x" },
    positionals: ["claude"],
  });
});

test("unknown commands and tools exit 2", () => {
  const { env } = setup();
  expect(runCn(["bogus"], { env }).status).toBe(2);
  expect(runCn(["model", "nope"], { env }).status).toBe(2);
  expect(runCn(["models", "--limit", "0"], { env }).status).toBe(2);
});

test("setup asks only for the key; config, model, and logout work end to end", () => {
  const { config, env } = setup({ CONCENTRATE_API_KEY: "" });
  const setupResult = runCn(["setup", "--no-verify"], {
    env,
    input: "sk-piped\n",
  });
  expect(setupResult.status, setupResult.stderr).toBe(0);
  expect(setupResult.stdout).toMatch(/ready/);
  expect(setupResult.stdout).toMatch(/cn claude\s+claude-sonnet-4-6/);
  expect(setupResult.stdout, "no per-tool model questions").not.toMatch(
    /default model/,
  );
  expect(
    JSON.parse(fs.readFileSync(path.join(config, "credentials.json"), "utf8"))
      .api_key,
  ).toBe("sk-piped");
  expect(
    fs.existsSync(path.join(config, "config.json")),
    "defaults need no config file",
  ).toBe(false);

  const modelResult = runCn(["model", "claude", "claude-opus-4-6"], { env });
  expect(modelResult.stdout).toMatch(
    /Claude Code\s+default model claude-opus-4-6/,
  );
  const configResult = runCn(["config"], { env });
  expect(configResult.stdout).toMatch(/api key\s+stored/);
  expect(configResult.stdout).toMatch(/Claude Code\s+claude-opus-4-6/);
  expect(configResult.stdout).not.toMatch(/sk-piped/);

  expect(runCn(["logout"], { env }).stdout).toMatch(/saved key removed/);
  expect(runCn(["config"], { env }).stdout).toMatch(/api key\s+missing/);
});

test("setup --models also asks for each tool's default", () => {
  const { config, env } = setup({ CONCENTRATE_API_KEY: "" });
  const result = runCn(["setup", "--no-verify", "--models"], {
    env,
    input: "sk-piped\n\n\n\n\n",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/Claude Code default model/);
  expect(fs.existsSync(path.join(config, "config.json"))).toBe(true);
});

test("reset needs --yes when not interactive, keeps Pi sessions, and can remove them", () => {
  const { config, env } = setup({ CONCENTRATE_API_KEY: "" });
  runCn(["setup", "--no-verify"], { env, input: "sk-piped\n\n\n\n" });
  fs.mkdirSync(path.join(config, "pi-sessions"));
  fs.writeFileSync(path.join(config, "pi-sessions", "s.jsonl"), "{}");

  const refused = runCn(["reset"], { env });
  expect(refused.status).toBe(2);
  expect(refused.stderr).toMatch(/--yes/);
  expect(
    fs.existsSync(path.join(config, "credentials.json")),
    "nothing removed without confirmation",
  ).toBe(true);

  const done = runCn(["reset", "--yes"], { env });
  expect(done.status, done.stderr).toBe(0);
  expect(done.stdout).toMatch(/removed\s+credentials\.json/);
  expect(done.stdout).toMatch(/Pi sessions/);
  expect(fs.existsSync(path.join(config, "credentials.json"))).toBe(false);
  expect(fs.existsSync(path.join(config, "config.json"))).toBe(false);
  expect(fs.existsSync(path.join(config, "catalog.json"))).toBe(false);
  expect(
    fs.existsSync(path.join(config, "pi-sessions", "s.jsonl")),
    "sessions are kept by default",
  ).toBe(true);

  expect(runCn(["reset", "--yes", "--sessions"], { env }).status).toBe(0);
  expect(fs.existsSync(config), "empty config dir is removed").toBe(false);
  expect(runCn(["reset"], { env }).stdout).toMatch(/already fresh/);
});

test("reset leaves an environment key alone and says so", () => {
  const { config, env } = setup({ CONCENTRATE_API_KEY: "sk-env" });
  runCn(["model", "claude", "claude-opus-4-6"], { env });
  const result = runCn(["reset", "--yes"], { env });
  expect(result.stdout).toMatch(/CONCENTRATE_API_KEY is still set/);
  expect(fs.existsSync(path.join(config, "config.json"))).toBe(false);
});

test("claude never receives the user's own Anthropic credentials or a bypass flag", () => {
  const { bin, env } = setup();
  const record = path.join(bin, "env.json");
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.env));`,
    { mode: 0o755 },
  );
  const leaky = {
    ANTHROPIC_API_KEY: "some-other-provider-key",
    ANTHROPIC_AUTH_TOKEN: "users-own-token",
    ANTHROPIC_CUSTOM_HEADERS: "X-Secret: 1",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_USE_FOUNDRY: "1",
  };
  expect(runCn(["claude"], { env: { ...env, ...leaky } }).status).toBe(0);
  const seen = JSON.parse(fs.readFileSync(record, "utf8"));
  expect(seen.ANTHROPIC_API_KEY).toBe(undefined);
  expect(seen.ANTHROPIC_AUTH_TOKEN).toBe(undefined);
  expect(seen.ANTHROPIC_CUSTOM_HEADERS).toBe(undefined);
  expect(seen.CLAUDE_CODE_OAUTH_TOKEN).toBe(undefined);
  expect(seen.CLAUDE_CODE_USE_BEDROCK).toBe(undefined);
  expect(seen.CLAUDE_CODE_USE_VERTEX).toBe(undefined);
  expect(seen.CLAUDE_CODE_USE_FOUNDRY).toBe(undefined);
  expect(seen.CN_CLAUDE_KEY).toBe("sk-test");
  expect(seen.ANTHROPIC_BASE_URL).toBe("https://api.concentrate.ai");
});

test("a relative PATH entry never resolves a tool from the current directory", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "claude"), "#!/bin/sh\n", { mode: 0o755 });
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    expect(which("claude", ".")).toBe(null);
    expect(which("claude", dir)).toBe(path.join(dir, "claude"));
  } finally {
    process.chdir(cwd);
  }
});

test("a model ID that looks like a flag is refused before anything launches", () => {
  const { bin, env } = setup();
  fakeTool(bin, "claude");
  const result = runCn(
    ["claude", "--model", "--dangerously-skip-permissions"],
    { env },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/Not a valid model ID/);
  expect(fs.existsSync(path.join(bin, "claude.record.json"))).toBe(false);
});

test("the Codex catalog ranks models in cn's order, first model first", async () => {
  const dir = tempDir();
  const fakeCodex = path.join(dir, "codex");
  fakeTool(dir, "codex");
  const file = writeCodexCatalog(
    fakeCodex,
    [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ],
    path.join(dir, "models.json"),
  );
  expect(JSON.parse(fs.readFileSync(file, "utf8")).models).toMatchObject([
    { slug: "a", priority: 1 },
    { slug: "b", priority: 2 },
    { slug: "c", priority: 3 },
  ]);
});
