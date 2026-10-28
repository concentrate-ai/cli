import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { summarize } from "../dist/lib/catalog.js";
import { parseConfig } from "../dist/lib/config-formats.js";
import {
  codexProviderPresent,
  configureCodexProvider,
  configureTool,
  resetTool,
  toolConfigured,
  toolConfigPaths,
} from "../dist/lib/tool-config.js";
import {
  readJson,
  writeJson,
  writeKey,
  writePreferences,
} from "../dist/lib/settings.js";
import { fakeTool, tempDir, runCn } from "./helpers.mjs";

const models = ["gpt-small", "gpt-large"].map((id, index) =>
  summarize({
    id,
    name: id,
    context_window: index ? 128000 : 32768,
    max_input_tokens: index ? 128000 : 32768,
    max_tokens: 4096,
    integrations: {
      claude_code: { supported: true },
      codex: { supported: true },
    },
    providers: {
      a: {
        context_window: index ? 128000 : 32768,
        max_output_tokens: 4096,
        supports: {
          input: { text: true, image: { png: true } },
          tools: { function_calling: true },
          reasoning: { effort: { low: true, high: true } },
        },
      },
    },
  }),
);
function fixture() {
  const dir = tempDir("cn-native-quoted-'-$-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const env = {
    HOME: dir,
    CN_CONFIG_HOME: path.join(dir, "cn"),
    CN_OFFLINE: "1",
    PATH: `${bin}:${path.dirname(process.execPath)}`,
    CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
    CODEX_HOME: path.join(dir, "codex"),
    PI_CODING_AGENT_DIR: path.join(dir, "pi"),
    XDG_CONFIG_HOME: path.join(dir, "config"),
    XDG_DATA_HOME: path.join(dir, "data"),
  };
  writeKey("sk-native-test", env);
  writePreferences(
    {
      claude: "gpt-small",
      codex: "gpt-small",
      opencode: "gpt-small",
      pi: "gpt-small",
    },
    env,
  );
  writeJson(path.join(env.CN_CONFIG_HOME, "catalog.json"), {
    version: 3,
    fetched_at: Date.now(),
    models,
  });
  for (const id of ["claude", "codex", "opencode", "pi"]) fakeTool(bin, id);
  return env;
}

for (const id of ["claude", "codex", "opencode", "pi"]) {
  test(`${id}: native Configure is repeatable and Reset restores exact original bytes`, async () => {
    const env = fixture();
    const files = toolConfigPaths(id, env);
    const original =
      id === "codex"
        ? '# User comment\nmodel = "original"\n[projects."/project"]\ntrust_level = "trusted"\n'
        : '{\n  "theme": "dark",\n  "model": "original"\n}\n';
    fs.mkdirSync(path.dirname(files.settings), { recursive: true });
    fs.writeFileSync(files.settings, original, { mode: 0o600 });
    await configureTool(id, env);
    assert.equal(toolConfigured(id, env), true);
    const first = fs.readFileSync(files.settings, "utf8");
    await configureTool(id, env);
    assert.equal(fs.readFileSync(files.settings, "utf8"), first);
    assert.equal(
      fs.existsSync(path.join(env.HOME, ".zshrc")),
      false,
      "Must not change shell startup files",
    );
    assert.equal(
      first.includes("sk-native-test"),
      false,
      "Never put keys in model settings",
    );
    if (id !== "opencode") {
      const helper = spawnSync(files.helper, [], {
        env: { PATH: path.dirname(process.execPath) },
        encoding: "utf8",
      });
      assert.equal(helper.status, 0, helper.stderr);
      assert.equal(helper.stdout.trim(), "sk-native-test");
      writeKey("sk-rotated", env);
      assert.equal(
        spawnSync(files.helper, [], { encoding: "utf8" }).stdout.trim(),
        "sk-rotated",
      );
    }
    const result = resetTool(id, env);
    assert.equal(result.reset, true);
    assert.deepEqual(result.preserved, []);
    assert.equal(toolConfigured(id, env), false);
    assert.equal(fs.readFileSync(files.settings, "utf8"), original);
    assert.equal(resetTool(id, env).reset, false);
  });
  test(`${id}: Reset preserves user edits and restores fields cn still owns`, async () => {
    const env = fixture();
    await configureTool(id, env);
    const files = toolConfigPaths(id, env);
    const format = id === "codex" ? "toml" : "json";
    let text = fs.readFileSync(files.settings, "utf8");
    text =
      id === "codex"
        ? text.replace('model = "gpt-small"', 'model = "user-selected"') +
          "\n[custom]\nkeep = true\n"
        : JSON.stringify({
            ...JSON.parse(text),
            [id === "pi" ? "defaultModel" : "model"]: "user-selected",
            theme: "light",
          });
    fs.writeFileSync(files.settings, text);
    await assert.rejects(configureTool(id, env), /edited after Configure/);
    const result = resetTool(id, env);
    const restored = parseConfig(
      fs.readFileSync(files.settings, "utf8"),
      format,
    );
    assert.equal(
      restored[id === "pi" ? "defaultModel" : "model"],
      "user-selected",
    );
    assert.ok(
      result.preserved.some((field) =>
        field.endsWith(id === "pi" ? ": defaultModel" : ": model"),
      ),
    );
    if (id === "codex") {
      assert.equal(restored.custom.keep, true);
      assert.equal(restored.model_provider, undefined);
    } else assert.equal(restored.theme, "light");
  });
}

test("Claude installs a persistent capability plugin; Pi and OpenCode keep context/output metadata", async () => {
  const env = fixture();
  await configureTool("claude", env);
  const plugins = JSON.parse(
    fs.readFileSync(toolConfigPaths("claude", env).installedPlugins),
  );
  const plugin = plugins.plugins["cn-context@concentrate-cn"][0].installPath;
  const { pathToFileURL } = await import("node:url");
  const limits = await import(
    pathToFileURL(path.join(plugin, "hooks", "limits.mjs"))
  );
  assert.equal(limits.limits["gpt-small"], models[0].context);
  assert.equal(limits.limits["gpt-large"], models[1].context);
  const settings = JSON.parse(
    fs.readFileSync(toolConfigPaths("claude", env).settings, "utf8"),
  );
  assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  assert.equal(settings.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
  await configureTool("pi", env);
  const pi = JSON.parse(
    fs.readFileSync(toolConfigPaths("pi", env).catalog, "utf8"),
  );
  assert.equal(
    pi.providers.concentrate.models[0].contextWindow,
    models[0].context,
  );
  assert.equal(pi.providers.concentrate.models[0].maxTokens, models[0].output);
  await configureTool("opencode", env);
  const oc = JSON.parse(
    fs.readFileSync(toolConfigPaths("opencode", env).settings, "utf8"),
  );
  assert.equal(
    oc.provider.concentrate.models["gpt-small"].limit.context,
    models[0].context,
  );
  assert.equal(
    oc.provider.concentrate.models["gpt-small"].limit.output,
    models[0].output,
  );
  const authFile = toolConfigPaths("opencode", env).catalog;
  assert.equal(fs.statSync(authFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(authFile, "utf8"), "sk-native-test");
});

test("bad JSON, symlinks, and environment-only keys fail without changing native settings", async () => {
  const env = fixture();
  const files = toolConfigPaths("claude", env);
  fs.mkdirSync(path.dirname(files.settings), { recursive: true });
  fs.writeFileSync(files.settings, "invalid");
  await assert.rejects(configureTool("claude", env), /invalid/);
  assert.equal(fs.readFileSync(files.settings, "utf8"), "invalid");
  fs.unlinkSync(files.settings);
  const target = path.join(env.HOME, "outside.json");
  fs.writeFileSync(target, "{}");
  fs.symlinkSync(target, files.settings);
  await assert.rejects(configureTool("claude", env), /non-regular/);
  assert.equal(fs.readFileSync(target, "utf8"), "{}");
  fs.unlinkSync(path.join(env.CN_CONFIG_HOME, "credentials.json"));
  await assert.rejects(
    configureTool("pi", { ...env, CONCENTRATE_API_KEY: "sk-env" }),
    /environment-only/,
  );
});

test("OpenCode JSONC comments and other providers survive Configure and Reset", async () => {
  const env = fixture();
  const dir = path.join(env.XDG_CONFIG_HOME, "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "opencode.jsonc");
  fs.writeFileSync(
    file,
    '{\n // keep this comment\n "provider": {"other": {"name": "mine"}},\n}\n',
  );
  const original = fs.readFileSync(file, "utf8");
  await configureTool("opencode", env);
  assert.match(fs.readFileSync(file, "utf8"), /keep this comment/);
  assert.equal(
    parseConfig(fs.readFileSync(file, "utf8"), "json").provider.other.name,
    "mine",
  );
  resetTool("opencode", env);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("CLI Configure and Reset select one tool and keep global cn preferences", () => {
  const env = fixture();
  const result = runCn(["configure", "pi"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(toolConfigured("pi", env), true);
  assert.equal(runCn(["reset", "pi"], { env }).status, 0);
  assert.equal(toolConfigured("pi", env), false);
  assert.equal(
    readJson(path.join(env.CN_CONFIG_HOME, "credentials.json")).api_key,
    "sk-native-test",
  );
});

test("saved-key rotation updates OpenCode’s private credential file and Logout restores the previous provider", async () => {
  const env = fixture();
  await configureTool("opencode", env);
  const file = toolConfigPaths("opencode", env).catalog;
  const rotated = runCn(["key", "--no-verify"], {
    env,
    input: "sk-new-native\n",
  });
  assert.equal(rotated.status, 0, rotated.stderr);
  assert.equal(fs.readFileSync(file, "utf8"), "sk-new-native");
  assert.equal(runCn(["logout"], { env }).status, 0);
  assert.equal(toolConfigured("opencode", env), false);
  assert.equal(fs.existsSync(file), false);
});

test("changing a default also updates an already configured native tool", async () => {
  const env = fixture();
  await configureTool("pi", env);
  const result = runCn(["model", "pi", "gpt-large"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(fs.readFileSync(toolConfigPaths("pi", env).settings))
      .defaultModel,
    "gpt-large",
  );
});

test("global Reset restores native tools before deleting cn credentials", async () => {
  const env = fixture();
  await configureTool("claude", env);
  await configureTool("pi", env);
  const result = runCn(["reset", "--yes"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(toolConfigured("claude", env), false);
  assert.equal(toolConfigured("pi", env), false);
  assert.equal(fs.existsSync(toolConfigPaths("claude", env).settings), false);
  assert.equal(
    fs.existsSync(path.join(env.CN_CONFIG_HOME, "credentials.json")),
    false,
  );
});

test("Claude Reset preserves plugins installed after Configure, including the shared registry version", async () => {
  const env = fixture();
  await configureTool("claude", env);
  const file = toolConfigPaths("claude", env).installedPlugins;
  const doc = JSON.parse(fs.readFileSync(file));
  doc.plugins["other@mine"] = [
    { scope: "user", installPath: "/my/other/plugin", version: "1" },
  ];
  fs.writeFileSync(file, JSON.stringify(doc));
  resetTool("claude", env);
  const restored = JSON.parse(fs.readFileSync(file));
  assert.equal(restored.version, 2);
  assert.equal(restored.plugins["cn-context@concentrate-cn"], undefined);
  assert.equal(
    restored.plugins["other@mine"][0].installPath,
    "/my/other/plugin",
  );
});

for (const id of ["codex", "opencode", "pi"]) {
  test(`${id}: Configure adds X-App and Reset removes only its setup`, async () => {
    const env = fixture();
    await configureTool(id, env);
    const files = toolConfigPaths(id, env);
    const doc = parseConfig(
      fs.readFileSync(id === "pi" ? files.catalog : files.settings, "utf8"),
      id === "codex" ? "toml" : "json",
    );
    const headers =
      id === "codex"
        ? doc.model_providers.concentrate.http_headers
        : id === "opencode"
          ? doc.provider.concentrate.options.headers
          : doc.providers.concentrate.headers;
    assert.equal(headers["X-App"], id);
    assert.equal(resetTool(id, env).reset, true);
    assert.equal(
      fs.existsSync(id === "pi" ? files.catalog : files.settings),
      false,
    );
  });
  test(`${id}: Configure preserves an existing mixed-case X-App and other headers`, async () => {
    const env = fixture();
    const files = toolConfigPaths(id, env);
    const target = id === "pi" ? files.catalog : files.settings;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const original =
      id === "codex"
        ? '[model_providers.concentrate.http_headers]\n"x-aPP" = "my-tool"\n"X-Other" = "keep"\n'
        : JSON.stringify({
            [id === "opencode" ? "provider" : "providers"]: {
              concentrate: {
                ...(id === "opencode"
                  ? {
                      options: {
                        headers: { "x-aPP": "my-tool", "X-Other": "keep" },
                      },
                    }
                  : { headers: { "x-aPP": "my-tool", "X-Other": "keep" } }),
              },
            },
          });
    fs.writeFileSync(target, original);
    await configureTool(id, env);
    const doc = parseConfig(
      fs.readFileSync(target, "utf8"),
      id === "codex" ? "toml" : "json",
    );
    const headers =
      id === "codex"
        ? doc.model_providers.concentrate.http_headers
        : id === "opencode"
          ? doc.provider.concentrate.options.headers
          : doc.providers.concentrate.headers;
    assert.deepEqual({ ...headers }, { "x-aPP": "my-tool", "X-Other": "keep" });
    await configureTool(id, env);
    resetTool(id, env);
    assert.equal(fs.readFileSync(target, "utf8"), original);
  });
}

test("codex: adding only the provider keeps the default provider, model, and comments, and Reset restores the file", () => {
  const env = fixture();
  const { settings } = toolConfigPaths("codex", env);
  const original =
    '# my notes\nmodel = "gpt-6-sol" # keep\n\n[tui]\ntheme = "dark"\n';
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, original);
  assert.equal(codexProviderPresent(env), false);

  configureCodexProvider(env);
  const doc = parseConfig(fs.readFileSync(settings, "utf8"), "toml");
  assert.equal(doc.model, "gpt-6-sol");
  assert.equal(doc.model_provider, undefined);
  assert.equal(doc.model_catalog_json, undefined);
  assert.equal(doc.model_providers.concentrate.wire_api, "responses");
  assert.ok(doc.model_providers.concentrate.auth.command);
  assert.match(fs.readFileSync(settings, "utf8"), /# my notes/);
  assert.equal(codexProviderPresent(env), true);
  assert.equal(toolConfigured("codex", env), true);

  resetTool("codex", env);
  assert.equal(fs.readFileSync(settings, "utf8"), original);
  assert.equal(codexProviderPresent(env), false);
});

test("codex: the provider-only setup needs a saved key and is not offered when the config is unreadable", () => {
  const env = fixture();
  fs.rmSync(path.join(env.CN_CONFIG_HOME, "credentials.json"));
  assert.throws(() => configureCodexProvider(env), /Save your key/);
  const { settings } = toolConfigPaths("codex", env);
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, "not = [valid toml");
  assert.equal(codexProviderPresent(env), true);
});
