import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import { fakeTool, runCn, tempDir, setup, writeCatalog } from "../helpers.js";

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

test("claude starts on the newest Sonnet and lists the newest Sonnet, Opus, and DeepSeek Flash first", () => {
  const { bin, config, env } = setup();
  const record = fakeTool(bin, "claude");
  const dated = (id, released) => ({ id, name: id, claude: true, released });
  writeCatalog(config, [
    dated("claude-haiku-5-5", "2026-10-07"),
    dated("claude-opus-4-6", "2026-02-05"),
    dated("claude-opus-5-5", "2026-09-22"),
    dated("claude-sonnet-4-6", "2026-02-17"),
    dated("claude-sonnet-5-5", "2026-09-28"),
    dated("deepseek-v4-1-fast", "2026-10-17"),
    dated("deepseek-v4-1-flash", "2026-09-10"),
  ]);
  const result = runCn(["claude"], { env });
  expect(result.status, result.stderr).toBe(0);
  const { args } = record();
  expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
  const { modelPicker } = JSON.parse(args[1]);
  expect(modelPicker.options).toHaveLength(7);
  expect(modelPicker.options[0].model).toBe("claude-sonnet-5-5");
  expect(modelPicker.options[1].model).toBe("claude-opus-5-5");
  expect(modelPicker.options[2].model).toBe("deepseek-v4-1-flash");
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
