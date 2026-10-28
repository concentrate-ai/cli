import { appHeaders } from "./app-headers.js";
import type {
  ClaudeSettings,
  OpenCodeModel,
  PiModel,
} from "./harness-config.js";
import { EFFORTS, modelEfforts, defaultModelEffort } from "./model-metadata.js";
import { isRecord, record } from "./validation.js";
import type { Environment, Model } from "./types.js";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

import { CnError } from "./errors.js";

const CLAUDE_PREFERRED = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "deepseek-v4-1-flash",
];

function claudeModelOptions(selected: string, models: Model[]) {
  const byId = new Map(models.map((m) => [m.id, m]));
  const chosen: Model[] = [];
  const seen = new Set();
  const take = (item: Model) => {
    chosen.push(item);
    seen.add(item.id);
  };
  for (const id of [selected, ...CLAUDE_PREFERRED]) {
    const entry = byId.get(id);
    if (entry && !seen.has(id)) take(entry);
  }
  const family = (item: Model) => item.id.split("-")[0];
  const families = new Set(chosen.map(family));
  for (const item of models) {
    if (!seen.has(item.id) && !families.has(family(item))) {
      take(item);
      families.add(family(item));
    }
  }
  for (const item of models) {
    if (!seen.has(item.id)) take(item);
  }
  return chosen;
}

// Claude also reads credentials from the user's own settings files (an apiKeyHelper,
// or an env block). Flag settings outrank those, so cn blanks every credential and
// routing switch there and supplies its key only through a helper that reads it
// from the child's environment. The key itself never appears in argv or on disk.
export const CLAUDE_KEY_VAR = "CN_CLAUDE_KEY";
export const CLAUDE_BLANKED = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

export function claudeSettings(
  apiRoot: string,
  model: string,
  models: Model[],
): ClaudeSettings {
  return {
    apiKeyHelper: `printenv ${CLAUDE_KEY_VAR}`,
    env: {
      ...Object.fromEntries(CLAUDE_BLANKED.map((name) => [name, ""])),
      ANTHROPIC_BASE_URL: apiRoot,
      ANTHROPIC_MODEL: model,
    },
    modelPicker: {
      replaceBuiltInOptions: true,
      options: claudeModelOptions(model, models).map((entry) => ({
        model: entry.id,
        label: entry.name,
        description: "Concentrate AI",
      })),
    },
  };
}

// Both OpenCode generations accept explicit model metadata, in different shapes.
const positiveTokens = (value: number | null): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function opencodeConfig(
  apiRoot: string,
  model: string,
  models: Model[],
  { modern = false, headers = appHeaders("opencode") } = {},
) {
  const entries = Object.fromEntries(
    models.map((entry): [string, OpenCodeModel] => {
      const limit = {
        ...(positiveTokens(entry.context) ? { context: entry.context } : {}),
        ...(positiveTokens(entry.output) ? { output: entry.output } : {}),
      };
      const efforts = modelEfforts(entry);
      const common = {
        name: entry.name,
        ...(Object.keys(limit).length ? { limit } : {}),
      };
      if (modern)
        return [
          entry.id,
          {
            ...common,
            // Explicit variants also cover v2 releases predating capabilities.reasoning.
            ...(efforts
              ? {
                  variants: efforts.map((level) => ({
                    id: level,
                    body: { reasoning_effort: level },
                  })),
                }
              : {}),
            capabilities: {
              ...(typeof entry.chat_candidate === "boolean"
                ? { tools: entry.chat_candidate }
                : {}),
              input: entry.image ? ["text", "image"] : ["text"],
              output: ["text"],
              ...(typeof entry.reasoningSupport === "boolean" ||
              entry.reasoning === true
                ? {
                    reasoning: {
                      supported: entry.reasoningSupport ?? entry.reasoning,
                      ...(efforts
                        ? {
                            effort: efforts.filter((level) => level !== "none"),
                            toggle: efforts.includes("none"),
                          }
                        : {}),
                    },
                  }
                : {}),
            },
          },
        ];
      return [
        entry.id,
        {
          ...common,
          modalities: {
            input: entry.image ? ["text", "image"] : ["text"],
            output: ["text"],
          },
          ...(typeof entry.chat_candidate === "boolean"
            ? { toolcall: entry.chat_candidate }
            : {}),
          ...(typeof entry.reasoningSupport === "boolean" ||
          entry.reasoning === true
            ? { reasoning: entry.reasoningSupport ?? entry.reasoning }
            : {}),
          ...(efforts
            ? {
                variants: Object.fromEntries(
                  efforts.map((level) => [level, { reasoningEffort: level }]),
                ),
              }
            : {}),
        },
      ];
    }),
  );
  if (modern)
    return {
      $schema: "https://opencode.ai/config.json",
      model: `concentrate/${model}`,
      providers: {
        concentrate: {
          package: "@opencode/ai/providers/openai-compatible",
          headers,
          name: "Concentrate AI",
          settings: {
            baseURL: `${apiRoot}/v1`,
            apiKey: "{env:CONCENTRATE_API_KEY}",
          },
          models: entries,
        },
      },
    };
  return {
    $schema: "https://opencode.ai/config.json",
    model: `concentrate/${model}`,
    provider: {
      concentrate: {
        npm: "@ai-sdk/openai-compatible",
        name: "Concentrate AI",
        options: {
          headers,
          baseURL: `${apiRoot}/v1`,
          apiKey: "{env:CONCENTRATE_API_KEY}",
        },
        models: entries,
      },
    },
  };
}

export function piConfig(
  apiRoot: string,
  models: Model[],
  headers = appHeaders("pi"),
) {
  const entries = models.map((entry) => {
    const data: PiModel = {
      id: entry.id,
      name: entry.name,
      input: entry.image ? ["text", "image"] : ["text"],
      reasoning: Boolean(entry.reasoning),
    };
    if (positiveTokens(entry.context)) data.contextWindow = entry.context;
    if (positiveTokens(entry.output)) data.maxTokens = entry.output;
    const efforts = modelEfforts(entry);
    if (data.reasoning && efforts) {
      data.thinkingLevelMap = Object.fromEntries(
        ["off", ...EFFORTS.filter((level) => level !== "none")].map((level) => [
          level,
          efforts.some(
            (effort) => effort === (level === "off" ? "none" : level),
          )
            ? level === "off"
              ? "none"
              : level
            : null,
        ]),
      );
    }
    return data;
  });
  return {
    providers: {
      concentrate: {
        baseUrl: `${apiRoot}/v1`,
        api: "openai-completions",
        apiKey: "$CONCENTRATE_API_KEY",
        headers,
        models: entries,
      },
    },
  };
}

export function writeCodexCatalog(
  executable: string,
  models: Model[],
  destination: string,
  { env = process.env }: { env?: Environment } = {},
) {
  // Follow Ori's approach: start with this Codex release's own model schema and
  // instructions instead of maintaining a hand-written approximation of it.
  const bundled = spawnSync(executable, ["debug", "models", "--bundled"], {
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  let templates: Record<string, unknown>[];
  try {
    const parsed: unknown = JSON.parse(bundled.stdout);
    const rows = record(parsed).models;
    if (!Array.isArray(rows)) throw new Error("Invalid bundled catalog");
    templates = rows.filter(isRecord);
  } catch {
    throw new CnError(
      "Could not read this Codex version's bundled model catalog",
    );
  }
  if (bundled.error || bundled.status !== 0 || !Array.isArray(templates)) {
    throw new CnError(
      "Could not read this Codex version's bundled model catalog",
    );
  }
  const template =
    templates.find((entry) => entry.slug === "gpt-5.5") ??
    templates.find(
      (entry) => entry && typeof entry.slug === "string" && !entry.tool_mode,
    );
  if (!template)
    throw new CnError("Codex has no compatible bundled model template");
  const messages = record(template.model_messages);
  const instructions = messages.instructions_template;
  const entries = models.map((item, index) => {
    const efforts = modelEfforts(item) ?? [];
    const context = positiveTokens(item.context)
      ? item.context
      : template.context_window;
    return {
      ...template,
      slug: item.id,
      display_name: item.name,
      description: "Concentrate AI model",
      visibility: "list",
      supported_in_api: true,
      // Codex lists lower priority first, so this keeps cn's order in its picker.
      priority: index + 1,
      default_reasoning_level: defaultModelEffort(item),
      supported_reasoning_levels: efforts.map((effort) => ({
        effort,
        description: `${effort} reasoning effort`,
      })),
      comp_hash: null,
      use_responses_lite: false,
      supports_search_tool: false,
      support_verbosity: false,
      additional_speed_tiers: [],
      service_tiers: [],
      experimental_supported_tools: [],
      ...(typeof instructions === "string" && instructions
        ? {
            model_messages: {
              ...messages,
              instructions_template: instructions.replace(
                / based on GPT-[0-9.]*[0-9]/g,
                "",
              ),
            },
          }
        : {}),
      input_modalities: item.image ? ["text", "image"] : ["text"],
      context_window: context,
      max_context_window: context,
      supports_experimental_context: false,
    };
  });
  fs.writeFileSync(destination, JSON.stringify({ models: entries }), {
    mode: 0o600,
  });
  // Validate against the exact installed Codex version before launching.
  const probe = spawnSync(
    executable,
    [
      "-c",
      `model_catalog_json=${JSON.stringify(destination)}`,
      "debug",
      "models",
    ],
    // Validation only needs the exit status. Real catalogs can be several MB;
    // buffering Codex's full JSON output can exceed Node's default limit.
    { env, stdio: "ignore", timeout: 15000 },
  );
  if (probe.error || probe.status !== 0) {
    throw new CnError(
      "This Codex version rejected the temporary model catalog",
    );
  }
  return destination;
}
