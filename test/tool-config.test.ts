import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect } from "vitest";
import { summarize } from "../dist/lib/catalog.js";
import { parseConfig } from "../dist/lib/config-formats.js";
import {
  codexProviderPresent,
  configureCodexProvider,
  configureTool,
  refreshConfiguredKey,
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
import { applyNativeSetup } from "../dist/lib/native-config-store.js";
import { runLogout } from "../dist/lib/commands.js";
import { refreshConfiguredTools } from "../dist/lib/update.js";
import { fakeTool, tempDir, runCn } from "./helpers.js";
import { pathToFileURL } from "node:url";

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
    version: 6,
    fetched_at: Date.now(),
    models,
  });
  for (const id of ["claude", "codex", "opencode", "pi"]) fakeTool(bin, id);
  return env;
}

const jsonOriginal = '{\n  "theme": "dark",\n  "model": "original"\n}\n';
const codexOriginal =
  '# User comment\nmodel = "original"\n[projects."/project"]\ntrust_level = "trusted"\n';

async function configureTwice(id, original) {
  const env = fixture();
  const files = toolConfigPaths(id, env);
  fs.mkdirSync(path.dirname(files.settings), { recursive: true });
  fs.writeFileSync(files.settings, original, { mode: 0o600 });
  await configureTool(id, env);
  expect(toolConfigured(id, env)).toBe(true);
  const first = fs.readFileSync(files.settings, "utf8");
  await configureTool(id, env);
  expect(fs.readFileSync(files.settings, "utf8")).toBe(first);
  expect(
    fs.existsSync(path.join(env.HOME, ".zshrc")),
    "Must not change shell startup files",
  ).toBe(false);
  return { env, files, first };
}

function expectExactReset(id, env, files, original) {
  const result = resetTool(id, env);
  expect(result.reset).toBe(true);
  expect(result.preserved).toStrictEqual([]);
  expect(toolConfigured(id, env)).toBe(false);
  expect(fs.readFileSync(files.settings, "utf8")).toBe(original);
  expect(resetTool(id, env).reset).toBe(false);
}

test("claude: native Configure is repeatable and Reset restores exact original bytes", async () => {
  const { env, files, first } = await configureTwice("claude", jsonOriginal);
  expect(
    first.includes("sk-native-test"),
    "Never put keys in model settings",
  ).toBe(false);
  const helper = spawnSync(files.helper, [], {
    env: { PATH: path.dirname(process.execPath) },
    encoding: "utf8",
  });
  expect(helper.status, helper.stderr).toBe(0);
  expect(helper.stdout.trim()).toBe("sk-native-test");
  writeKey("sk-rotated", env);
  expect(spawnSync(files.helper, [], { encoding: "utf8" }).stdout.trim()).toBe(
    "sk-rotated",
  );
  expectExactReset("claude", env, files, jsonOriginal);
});

test("codex: native Configure is repeatable and Reset restores exact original bytes", async () => {
  const { env, files } = await configureTwice("codex", codexOriginal);
  const bearer = () =>
    parseConfig(fs.readFileSync(files.settings, "utf8"), "toml").model_providers
      .concentrate.experimental_bearer_token;
  expect(bearer()).toBe("sk-native-test");
  expect(fs.existsSync(files.helper), "Codex needs no helper").toBe(false);
  writeKey("sk-rotated", env);
  refreshConfiguredKey(env);
  expect(bearer()).toBe("sk-rotated");
  expect(
    fs.statSync(files.settings).mode & 0o077,
    "Codex's key file must be private",
  ).toBe(0);
  expectExactReset("codex", env, files, codexOriginal);
});

test("opencode: native Configure is repeatable and Reset restores exact original bytes", async () => {
  const { env, files, first } = await configureTwice("opencode", jsonOriginal);
  expect(
    first.includes("sk-native-test"),
    "Never put keys in model settings",
  ).toBe(false);
  expectExactReset("opencode", env, files, jsonOriginal);
});

test("pi: native Configure is repeatable and Reset restores exact original bytes", async () => {
  const { env, files, first } = await configureTwice("pi", jsonOriginal);
  expect(
    first.includes("sk-native-test"),
    "Never put keys in model settings",
  ).toBe(false);
  const apiKey = () =>
    JSON.parse(fs.readFileSync(files.catalog, "utf8")).providers.concentrate
      .apiKey;
  expect(apiKey()).toBe("sk-native-test");
  expect(fs.existsSync(files.helper), "Pi needs no helper").toBe(false);
  writeKey("sk-rotated", env);
  refreshConfiguredKey(env);
  expect(apiKey()).toBe("sk-rotated");
  expect(
    fs.statSync(files.catalog).mode & 0o077,
    "Pi's key file must be private",
  ).toBe(0);
  expectExactReset("pi", env, files, jsonOriginal);
});

test("codex: Reset preserves user edits and restores fields cn still owns", async () => {
  const env = fixture();
  await configureTool("codex", env);
  const files = toolConfigPaths("codex", env);
  fs.writeFileSync(
    files.settings,
    fs
      .readFileSync(files.settings, "utf8")
      .replace('model = "gpt-small"', 'model = "user-selected"') +
      "\n[custom]\nkeep = true\n",
  );
  await expect(configureTool("codex", env)).rejects.toThrow(
    /edited after Configure/,
  );
  const result = resetTool("codex", env);
  const restored = parseConfig(fs.readFileSync(files.settings, "utf8"), "toml");
  expect(restored.model).toBe("user-selected");
  expect(result.preserved).toContainEqual(expect.stringMatching(/: model$/));
  expect(restored.custom.keep).toBe(true);
  expect(restored.model_provider).toBe(undefined);
});

test.each([
  ["claude", "model"],
  ["opencode", "model"],
  ["pi", "defaultModel"],
])(
  "%s: Reset preserves user edits and restores fields cn still owns",
  async (id, field) => {
    const env = fixture();
    await configureTool(id, env);
    const files = toolConfigPaths(id, env);
    fs.writeFileSync(
      files.settings,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(files.settings, "utf8")),
        [field]: "user-selected",
        theme: "light",
      }),
    );
    await expect(configureTool(id, env)).rejects.toThrow(
      /edited after Configure/,
    );
    const result = resetTool(id, env);
    const restored = parseConfig(
      fs.readFileSync(files.settings, "utf8"),
      "json",
    );
    expect(restored[field]).toBe("user-selected");
    expect(result.preserved).toContainEqual(
      expect.stringMatching(new RegExp(`: ${field}$`)),
    );
    expect(restored.theme).toBe("light");
  },
);

test("Claude installs a persistent capability plugin; Pi and OpenCode keep context/output metadata", async () => {
  const env = fixture();
  await configureTool("claude", env);
  const plugins = JSON.parse(
    fs.readFileSync(toolConfigPaths("claude", env).installedPlugins),
  );
  const plugin = plugins.plugins["cn-context@concentrate-cn"][0].installPath;
  const limits = await import(
    pathToFileURL(path.join(plugin, "hooks", "limits.mjs"))
  );
  expect(limits.limits["gpt-small"]).toBe(models[0].context);
  expect(limits.limits["gpt-large"]).toBe(models[1].context);
  const settings = JSON.parse(
    fs.readFileSync(toolConfigPaths("claude", env).settings, "utf8"),
  );
  expect(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(undefined);
  expect(settings.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(undefined);
  await configureTool("pi", env);
  const pi = JSON.parse(
    fs.readFileSync(toolConfigPaths("pi", env).catalog, "utf8"),
  );
  expect(pi.providers.concentrate.models[0].contextWindow).toBe(
    models[0].context,
  );
  expect(pi.providers.concentrate.models[0].maxTokens).toBe(models[0].output);
  await configureTool("opencode", env);
  const oc = JSON.parse(
    fs.readFileSync(toolConfigPaths("opencode", env).settings, "utf8"),
  );
  expect(oc.provider.concentrate.models["gpt-small"].limit.context).toBe(
    models[0].context,
  );
  expect(oc.provider.concentrate.models["gpt-small"].limit.output).toBe(
    models[0].output,
  );
  const authFile = toolConfigPaths("opencode", env).catalog;
  expect(fs.statSync(authFile).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(authFile, "utf8")).toBe("sk-native-test");
});

test("bad JSON, symlinks, and environment-only keys fail without changing native settings", async () => {
  const env = fixture();
  const files = toolConfigPaths("claude", env);
  fs.mkdirSync(path.dirname(files.settings), { recursive: true });
  fs.writeFileSync(files.settings, "invalid");
  await expect(configureTool("claude", env)).rejects.toThrow(/invalid/);
  expect(fs.readFileSync(files.settings, "utf8")).toBe("invalid");
  fs.unlinkSync(files.settings);
  const target = path.join(env.HOME, "outside.json");
  fs.writeFileSync(target, "{}");
  fs.symlinkSync(target, files.settings);
  await expect(configureTool("claude", env)).rejects.toThrow(/non-regular/);
  expect(fs.readFileSync(target, "utf8")).toBe("{}");
  fs.unlinkSync(path.join(env.CN_CONFIG_HOME, "credentials.json"));
  await expect(
    configureTool("pi", { ...env, CONCENTRATE_API_KEY: "sk-env" }),
  ).rejects.toThrow(/environment-only/);
});

test("pi: Configure refuses versions before 0.77 without writing", async () => {
  const env = fixture();
  fakeTool(path.join(env.HOME, "bin"), "pi", {
    version: "0.76.2",
    versionOnStderr: true,
  });
  await expect(configureTool("pi", env)).rejects.toThrow(/pi update self/);
  expect(fs.existsSync(toolConfigPaths("pi", env).catalog)).toBe(false);
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
  expect(fs.readFileSync(file, "utf8")).toMatch(/keep this comment/);
  expect(
    parseConfig(fs.readFileSync(file, "utf8"), "json").provider.other.name,
  ).toBe("mine");
  resetTool("opencode", env);
  expect(fs.readFileSync(file, "utf8")).toBe(original);
});

test("CLI Configure and Reset select one tool and keep global cn preferences", () => {
  const env = fixture();
  const result = runCn(["configure", "pi"], { env });
  expect(result.status, result.stderr).toBe(0);
  expect(toolConfigured("pi", env)).toBe(true);
  expect(runCn(["reset", "pi"], { env }).status).toBe(0);
  expect(toolConfigured("pi", env)).toBe(false);
  expect(
    readJson(path.join(env.CN_CONFIG_HOME, "credentials.json")).api_key,
  ).toBe("sk-native-test");
});

test("saved-key rotation updates OpenCode’s private credential file and Logout restores the previous provider", async () => {
  const env = fixture();
  await configureTool("opencode", env);
  const file = toolConfigPaths("opencode", env).catalog;
  const rotated = runCn(["key", "--no-verify"], {
    env,
    input: "sk-new-native\n",
  });
  expect(rotated.status, rotated.stderr).toBe(0);
  expect(fs.readFileSync(file, "utf8")).toBe("sk-new-native");
  expect(runCn(["logout"], { env }).status).toBe(0);
  expect(toolConfigured("opencode", env)).toBe(false);
  expect(fs.existsSync(file)).toBe(false);
});

test("changing a default also updates an already configured native tool", async () => {
  const env = fixture();
  await configureTool("pi", env);
  const result = runCn(["model", "pi", "gpt-large"], { env });
  expect(result.status, result.stderr).toBe(0);
  expect(
    JSON.parse(fs.readFileSync(toolConfigPaths("pi", env).settings))
      .defaultModel,
  ).toBe("gpt-large");
});

test("global Reset restores native tools before deleting cn credentials", async () => {
  const env = fixture();
  await configureTool("claude", env);
  await configureTool("pi", env);
  const result = runCn(["reset", "--yes"], { env });
  expect(result.status, result.stderr).toBe(0);
  expect(toolConfigured("claude", env)).toBe(false);
  expect(toolConfigured("pi", env)).toBe(false);
  expect(fs.existsSync(toolConfigPaths("claude", env).settings)).toBe(false);
  expect(fs.existsSync(path.join(env.CN_CONFIG_HOME, "credentials.json"))).toBe(
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
  expect(restored.version).toBe(2);
  expect(restored.plugins["cn-context@concentrate-cn"]).toBe(undefined);
  expect(restored.plugins["other@mine"][0].installPath).toBe(
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
    expect(headers["X-App"]).toBe(id);
    expect(resetTool(id, env).reset).toBe(true);
    expect(fs.existsSync(id === "pi" ? files.catalog : files.settings)).toBe(
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
    expect({ ...headers }).toStrictEqual({
      "x-aPP": "my-tool",
      "X-Other": "keep",
    });
    await configureTool(id, env);
    resetTool(id, env);
    expect(fs.readFileSync(target, "utf8")).toBe(original);
  });
}

test("codex: adding only the provider keeps the default provider, model, and comments, and Reset restores the file", () => {
  const env = fixture();
  const { settings } = toolConfigPaths("codex", env);
  const original =
    '# my notes\nmodel = "gpt-6-sol" # keep\n\n[tui]\ntheme = "dark"\n';
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, original);
  expect(codexProviderPresent(env)).toBe(false);

  configureCodexProvider(env);
  const doc = parseConfig(fs.readFileSync(settings, "utf8"), "toml");
  expect(doc.model).toBe("gpt-6-sol");
  expect(doc.model_provider).toBe(undefined);
  expect(doc.model_catalog_json).toBe(undefined);
  expect(doc.model_providers.concentrate.wire_api).toBe("responses");
  expect(doc.model_providers.concentrate.experimental_bearer_token).toBe(
    "sk-native-test",
  );
  expect(doc.model_providers.concentrate.auth).toBe(undefined);
  expect(fs.readFileSync(settings, "utf8")).toMatch(/# my notes/);
  expect(codexProviderPresent(env)).toBe(true);
  expect(toolConfigured("codex", env)).toBe(true);

  resetTool("codex", env);
  expect(fs.readFileSync(settings, "utf8")).toBe(original);
  expect(codexProviderPresent(env)).toBe(false);
});

test("codex: the provider-only setup needs a saved key and is not offered when the config is unreadable", () => {
  const env = fixture();
  fs.rmSync(path.join(env.CN_CONFIG_HOME, "credentials.json"));
  expect(() => configureCodexProvider(env)).toThrow(/Save your key/);
  const { settings } = toolConfigPaths("codex", env);
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, "not = [valid toml");
  expect(codexProviderPresent(env)).toBe(true);
});

const holdsTestKey = (file) =>
  fs.existsSync(file) &&
  fs.readFileSync(file, "utf8").includes("sk-native-test");

test("logout removes the key copies that Pi and Codex keep in their own config", async () => {
  const env = fixture();
  await configureTool("pi", env);
  await configureTool("codex", env);
  const pi = toolConfigPaths("pi", env).catalog;
  const codex = toolConfigPaths("codex", env).settings;
  expect(fs.readFileSync(pi, "utf8")).toMatch(/sk-native-test/);
  expect(fs.readFileSync(codex, "utf8")).toMatch(/sk-native-test/);
  const log = console.log;
  console.log = () => {};
  try {
    runLogout(env);
  } finally {
    console.log = log;
  }
  expect(holdsTestKey(pi), `${pi} still holds the key after logout`).toBe(
    false,
  );
  expect(holdsTestKey(codex), `${codex} still holds the key after logout`).toBe(
    false,
  );
});

test("a key change leaves a Codex setup from an older cn (helper based) loadable", () => {
  const env = fixture();
  const { settings, helper } = toolConfigPaths("codex", env);
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  // The shape v0.1.0 wrote: the provider asks a helper for the key.
  applyNativeSetup(
    path.join(env.CN_CONFIG_HOME, "tool-setups", "codex", "restore.json"),
    [
      {
        file: settings,
        format: "toml",
        changes: [
          {
            key: ["model_providers", "concentrate"],
            value: {
              name: "Concentrate AI",
              base_url: "https://api.concentrate.ai/v1",
              wire_api: "responses",
              auth: { command: helper, args: [], timeout_ms: 10000 },
            },
          },
        ],
      },
    ],
  );
  writeKey("sk-rotated", env);
  refreshConfiguredKey(env);
  const provider = parseConfig(fs.readFileSync(settings, "utf8"), "toml")
    .model_providers.concentrate;
  expect(provider.experimental_bearer_token).toBe(undefined);
  expect(provider.auth.command).toBe(helper);
});

test("refreshing a provider-only Codex setup keeps Codex's own default provider", async () => {
  const env = fixture();
  const { settings } = toolConfigPaths("codex", env);
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, 'model = "gpt-6-sol"\n');
  configureCodexProvider(env);
  const log = console.log;
  console.log = () => {};
  try {
    expect(await refreshConfiguredTools(env)).toBe(0);
  } finally {
    console.log = log;
  }
  const doc = parseConfig(fs.readFileSync(settings, "utf8"), "toml");
  expect(doc.model_provider).toBe(undefined);
  expect(doc.model).toBe("gpt-6-sol");
  expect(doc.model_providers.concentrate.experimental_bearer_token).toBe(
    "sk-native-test",
  );
});
