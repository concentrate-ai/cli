import {
  configureCursor,
  resetCursor,
  cursorConfigured,
  refreshCursorKey,
} from "./cursor-config.js";
import {
  appHeaders,
  codexHeaderConfig,
  configDocument,
  openCodeHeaders,
} from "./app-headers.js";
import { record } from "./validation.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_ROOT,
  fetchCatalog,
  modelsFor,
  routingModelId,
} from "./catalog.js";
import {
  permanentClaudePlugin,
  PERMANENT_CLAUDE_PLUGIN,
} from "./claude-permanent.js";
import { CnError } from "./errors.js";
import { which } from "./executables.js";
import { getHarness } from "./harnesses/registry.js";
import { supportsStandalone } from "./harnesses/opencode.js";
import {
  CLAUDE_BLANKED,
  claudeSettings,
  opencodeConfig,
  piConfig,
  writeCodexCatalog,
} from "./pickers.js";
import { configDir, readPreferences, readStoredKey } from "./settings.js";
import {
  applyNativeSetup,
  hasNativeSetup,
  resetNativeSetup,
  refreshNativeCredential,
  withSetupLock,
  type ConfigPlan,
} from "./native-config-store.js";
import { defaultModelEffort } from "./model-metadata.js";
import type { Environment, HarnessId, ConfigurableToolId } from "./types.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const home = (env: Environment) => path.resolve(env.HOME || os.homedir());
export const toolSetupDir = (
  id: ConfigurableToolId,
  env: Environment = process.env,
) => path.join(configDir(env), "tool-setups", id);
const receiptFile = (id: HarnessId, env: Environment) =>
  path.join(toolSetupDir(id, env), "restore.json");
export const toolConfigured = (
  id: ConfigurableToolId,
  env: Environment = process.env,
) =>
  id === "cursor"
    ? cursorConfigured(env)
    : hasNativeSetup(receiptFile(id, env));

export function toolConfigPaths(id: HarnessId, env: Environment = process.env) {
  const root = home(env);
  const artifact = toolSetupDir(id, env);
  const helper = path.join(artifact, "credential-helper");
  if (id === "claude")
    return {
      settings: path.join(
        env.CLAUDE_CONFIG_DIR || path.join(root, ".claude"),
        "settings.json",
      ),
      catalog: path.join(env.CLAUDE_CONFIG_DIR || root, ".claude.json"),
      helper,
      installedPlugins: path.join(
        env.CLAUDE_CONFIG_DIR || path.join(root, ".claude"),
        "plugins",
        "installed_plugins.json",
      ),
      marketplaces: path.join(
        env.CLAUDE_CONFIG_DIR || path.join(root, ".claude"),
        "plugins",
        "known_marketplaces.json",
      ),
    };
  if (id === "codex")
    return {
      settings: path.join(
        env.CODEX_HOME || path.join(root, ".codex"),
        "config.toml",
      ),
      catalog: path.join(artifact, "models.json"),
      helper,
    };
  if (id === "pi")
    return {
      settings: path.join(
        env.PI_CODING_AGENT_DIR || path.join(root, ".pi", "agent"),
        "settings.json",
      ),
      catalog: path.join(
        env.PI_CODING_AGENT_DIR || path.join(root, ".pi", "agent"),
        "models.json",
      ),
      helper,
    };
  const directory = path.join(
    env.XDG_CONFIG_HOME || path.join(root, ".config"),
    "opencode",
  );
  const jsonc = path.join(directory, "opencode.jsonc");
  const json = path.join(directory, "opencode.json");
  if (!env.OPENCODE_CONFIG && fs.existsSync(jsonc) && fs.existsSync(json))
    throw new CnError(
      "Both global OpenCode JSON and JSONC files exist. Set OPENCODE_CONFIG to the file to configure.",
    );
  return {
    settings: env.OPENCODE_CONFIG || (fs.existsSync(jsonc) ? jsonc : json),
    catalog: path.join(artifact, "api-key"),
    helper,
  };
}

function helperScript(env: Environment) {
  return `#!/bin/sh\n# Concentrate native configuration credential helper\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL("../bin/cn.js", import.meta.url)))} --credential-helper ${quote(configDir(env))}\n`;
}

function jsonPlan(file: string, entries: [string[], unknown][]): ConfigPlan {
  return {
    file,
    format: "json",
    changes: entries.map(([key, value]) => ({ key, value })),
  };
}

export async function configureTool(
  id: ConfigurableToolId,
  env: Environment = process.env,
) {
  if (id === "cursor") {
    const key = readStoredKey(env);
    if (!key)
      throw new CnError(
        "Save your Concentrate API key with cn key before configuring Cursor.",
      );
    const { models } = await fetchCatalog({ env });
    return configureCursor(API_ROOT, key, models, env);
  }
  const adapter = getHarness(id);
  const executable = which(adapter.binary, env.PATH);
  if (!executable)
    throw new CnError(
      `${adapter.label} is not installed. ${adapter.installHint}`,
    );
  // Native apps need a saved key; environment-only keys are unavailable from the Dock.
  const key = readStoredKey(env);
  if (!key)
    throw new CnError(
      "Save your key with cn key before configuring a tool permanently. An environment-only key is not enough for direct app launches.",
    );
  const { models } = await fetchCatalog({ env });
  const available = modelsFor(id, models);
  const model = routingModelId(available, readPreferences(env)[id]);
  const selected = available.find((entry) => entry.id === model);
  if (!selected)
    throw new CnError(
      `The default model ${model} is not in this tool's catalog. Choose a listed default in Settings first.`,
    );
  const files = toolConfigPaths(id, env);
  const plans: ConfigPlan[] = [];
  if (id !== "opencode")
    plans.push({
      file: files.helper,
      format: "text",
      mode: 0o700,
      changes: [{ key: ["content"], value: helperScript(env) }],
    });
  if (id === "claude") {
    plans.push(
      ...permanentClaudePlugin(
        executable,
        available,
        path.dirname(files.settings),
        path.join(toolSetupDir(id, env), "managed-plugin"),
        env,
      ),
    );
    plans.push(
      jsonPlan(files.settings, [
        [["apiKeyHelper"], quote(files.helper)],
        [["model"], model],
        [
          ["modelPicker"],
          claudeSettings(API_ROOT, model, available).modelPicker,
        ],
        [["enabledPlugins", PERMANENT_CLAUDE_PLUGIN], true],
        [
          ["extraKnownMarketplaces", "concentrate-cn"],
          {
            source: {
              source: "directory",
              path: path.join(
                toolSetupDir(id, env),
                "managed-plugin",
                "market",
              ),
            },
          },
        ],
        [["env", "ANTHROPIC_BASE_URL"], API_ROOT],
        ...CLAUDE_BLANKED.map((name): [string[], unknown] => [
          ["env", name],
          "",
        ]),
        [["availableModels"], available.map((entry) => entry.id)],
      ]),
    );
  } else if (id === "pi") {
    plans.push(
      jsonPlan(files.settings, [
        [["defaultProvider"], "concentrate"],
        [["defaultModel"], model],
      ]),
    );
    const provider = piConfig(
      API_ROOT,
      available,
      appHeaders(
        "pi",
        record(record(configDocument(files.catalog).providers).concentrate)
          .headers,
      ),
    ).providers.concentrate;
    plans.push(
      jsonPlan(files.catalog, [
        [
          ["providers", "concentrate"],
          { ...provider, apiKey: `!${quote(files.helper)}` },
        ],
      ]),
    );
  } else if (id === "opencode") {
    const modern = supportsStandalone(executable);
    const generated = opencodeConfig(API_ROOT, model, available, {
      modern,
      headers: openCodeHeaders(env, modern, false),
    });
    const branch = modern ? "providers" : "provider";
    const provider = modern
      ? generated.providers?.concentrate
      : generated.provider?.concentrate;
    if (!provider)
      throw new CnError(
        "Cannot construct this OpenCode version's provider configuration.",
      );
    const configured = modern
      ? {
          ...provider,
          settings: {
            ...("settings" in provider ? provider.settings : {}),
            apiKey: `{file:${files.catalog}}`,
          },
        }
      : {
          ...provider,
          options: {
            ...("options" in provider ? provider.options : {}),
            apiKey: `{file:${files.catalog}}`,
          },
        };
    plans.push(
      jsonPlan(files.settings, [
        [["model"], generated.model],
        [[branch, "concentrate"], configured],
      ]),
    );
    plans.push({
      file: files.catalog,
      format: "text",
      changes: [{ key: ["content"], value: key }],
    });
  } else {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "cn-native-codex-"),
    );
    let catalog: string;
    try {
      const validationHome = path.join(temporary, "codex-home");
      fs.mkdirSync(validationHome);
      const file = writeCodexCatalog(
        executable,
        available,
        path.join(temporary, "models.json"),
        { env: { ...env, CODEX_HOME: validationHome } },
      );
      catalog = fs.readFileSync(file, "utf8");
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    plans.push({
      file: files.catalog,
      format: "text",
      changes: [{ key: ["content"], value: catalog }],
    });
    plans.push({
      file: files.settings,
      format: "toml",
      changes: [
        { key: ["model_provider"], value: "cn_concentrate" },
        { key: ["model"], value: model },
        { key: ["web_search"], value: "disabled" },
        {
          key: ["model_reasoning_effort"],
          value: defaultModelEffort(selected),
        },
        { key: ["model_catalog_json"], value: files.catalog },
        {
          key: ["model_providers", "cn_concentrate"],
          value: {
            name: "Concentrate AI",
            base_url: `${API_ROOT}/v1`,
            wire_api: "responses",
            ...codexHeaderConfig("cn_concentrate", env),
            auth: {
              command: files.helper,
              args: [],
              timeout_ms: 10000,
              refresh_interval_ms: 300000,
            },
          },
        },
      ],
    });
  }
  withSetupLock(toolSetupDir(id, env), () =>
    applyNativeSetup(receiptFile(id, env), plans),
  );
  return files.settings;
}

export function resetTool(
  id: ConfigurableToolId,
  env: Environment = process.env,
) {
  if (id === "cursor") return resetCursor(env);
  const files = toolConfigPaths(id, env);
  return withSetupLock(toolSetupDir(id, env), () =>
    resetNativeSetup(receiptFile(id, env), Object.values(files)),
  );
}

export function refreshConfiguredKey(env: Environment = process.env) {
  const saved = readStoredKey(env);
  if (saved && cursorConfigured(env)) {
    try {
      refreshCursorKey(saved, env);
    } catch {
      throw new CnError(
        "Your cn API key was saved, but Cursor's key could not be refreshed. Quit Cursor and run cn configure cursor; if it reports edited settings, Reset Cursor first.",
      );
    }
  }
  if (!toolConfigured("opencode", env)) return;
  const key = readStoredKey(env);
  if (!key) return;
  const files = toolConfigPaths("opencode", env);
  const refreshed = withSetupLock(toolSetupDir("opencode", env), () =>
    refreshNativeCredential(
      receiptFile("opencode", env),
      Object.values(files),
      files.catalog,
      key,
    ),
  );
  if (!refreshed)
    throw new CnError(
      "The key was saved, but OpenCode's credential was edited externally. Run cn configure opencode to review its integration.",
    );
}
