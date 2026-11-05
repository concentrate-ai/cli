import { appHeaders } from "./app-headers.js";
import type {
  ClaudeSettings,
  OpenCodeModel,
  PiModel,
} from "./harness-config.js";
import {
  EFFORTS,
  modelEfforts,
  defaultModelEffort,
} from "../model-metadata.js";
import { isRecord, positiveTokens, record } from "../validation.js";
import type { Effort, Environment, Model } from "../types.js";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

import { CnError } from "../errors.js";
import {
  CLAUDE_OPUS,
  CLAUDE_SONNET,
  DEEPSEEK_FLASH,
  newestInTier,
} from "../config/settings.js";

function claudeModelOptions(selected: string, models: Model[]) {
  const byId = new Map(models.map((m) => [m.id, m]));
  const chosen: Model[] = [];
  const seen = new Set();
  const take = (item: Model) => {
    chosen.push(item);
    seen.add(item.id);
  };
  const preferred = [CLAUDE_SONNET, CLAUDE_OPUS, DEEPSEEK_FLASH].map((tier) =>
    newestInTier(tier, models),
  );
  for (const id of [selected, ...preferred]) {
    const entry = byId.get(id ?? "");
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

// Claude's thinking setting on the Messages API for one reasoning level: an
// effort for adaptive models, a token budget for older ones.
function anthropicThinking(id: string, level: Effort) {
  if (level === "none") return { thinking: { type: "disabled" } };
  if (adaptiveClaude(id)) return { output_config: { effort: level } };
  const budget = { minimal: 2048, low: 4096, medium: 10000, high: 16384 };
  return {
    thinking: {
      type: "enabled",
      budget_tokens: budget[level as keyof typeof budget] ?? 32000,
    },
  };
}

// The same for OpenCode 1.x, whose Anthropic SDK takes its own option names.
function anthropicSdkThinking(id: string, level: Effort) {
  const body = anthropicThinking(id, level);
  if ("output_config" in body) return { effort: level };
  return "budget_tokens" in body.thinking
    ? {
        thinking: {
          type: "enabled",
          budgetTokens: body.thinking.budget_tokens,
        },
      }
    : body;
}

const openCodeInputs = (entry: Model) => [
  "text",
  ...(entry.image ? ["image"] : []),
  ...(entry.pdf ? ["pdf"] : []),
];

export function opencodeConfig(
  apiRoot: string,
  model: string,
  models: Model[],
  { modern = false, headers = appHeaders("opencode") } = {},
) {
  const entries = Object.fromEntries(
    models.map((entry): [string, OpenCodeModel] => {
      const context = positiveTokens(entry.context);
      const output = positiveTokens(entry.output);
      const limit = {
        ...(context ? { context } : {}),
        ...(output ? { output } : {}),
      };
      const efforts = modelEfforts(entry);
      const claude = isClaudeModel(entry.id);
      const common = {
        name: entry.name,
        ...(Object.keys(limit).length ? { limit } : {}),
      };
      if (modern)
        return [
          entry.id,
          {
            ...common,
            ...(entry.released ? { releaseDate: entry.released } : {}),
            ...(entry.cost
              ? {
                  cost: {
                    input: entry.cost.input,
                    output: entry.cost.output,
                    cache: {
                      read: entry.cost.cacheRead,
                      write: entry.cost.cacheWrite,
                    },
                  },
                }
              : {}),
            // Claude is cached as its conversation grows only on Concentrate's
            // Messages endpoint; on Responses earlier tool results are rewritten.
            ...(claude
              ? {
                  package: "@opencode/ai/providers/anthropic",
                  settings: { baseURL: `${apiRoot}/v1` },
                }
              : {}),
            // Explicit variants also cover v2 releases predating capabilities.reasoning.
            ...(efforts
              ? {
                  variants: efforts.map((level) => ({
                    id: level,
                    body: claude
                      ? anthropicThinking(entry.id, level)
                      : { reasoning: { effort: level } },
                  })),
                }
              : {}),
            capabilities: {
              ...(typeof entry.chat_candidate === "boolean"
                ? { tools: entry.chat_candidate }
                : {}),
              input: openCodeInputs(entry),
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
          ...(entry.released ? { release_date: entry.released } : {}),
          ...(entry.cost
            ? {
                cost: {
                  input: entry.cost.input,
                  output: entry.cost.output,
                  cache_read: entry.cost.cacheRead,
                  cache_write: entry.cost.cacheWrite,
                },
              }
            : {}),
          modalities: {
            input: openCodeInputs(entry),
            output: ["text"],
          },
          ...(typeof entry.chat_candidate === "boolean"
            ? { tool_call: entry.chat_candidate }
            : {}),
          ...(typeof entry.reasoningSupport === "boolean" ||
          entry.reasoning === true
            ? { reasoning: entry.reasoningSupport ?? entry.reasoning }
            : {}),
          // OpenCode 1.x: Claude through the Anthropic SDK and the Messages
          // endpoint, with that SDK's names for the thinking options.
          ...(claude ? { provider: { npm: "@ai-sdk/anthropic" } } : {}),
          ...(efforts
            ? {
                variants: Object.fromEntries(
                  efforts.map((level) => [
                    level,
                    claude
                      ? anthropicSdkThinking(entry.id, level)
                      : { reasoningEffort: level },
                  ]),
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
          // Responses API: Chat Completions does not cache Claude prompts.
          package: "@opencode/ai/providers/openai",
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
        // Responses API: Chat Completions does not cache Claude prompts.
        npm: "@ai-sdk/openai",
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

// Claude models, including provider-pinned IDs such as anthropic/claude-….
export const isClaudeModel = (id: string) =>
  (id.split("/").pop() ?? id).startsWith("claude-");

// A Claude model's version, such as [4, 6] for claude-sonnet-4-6.
function claudeVersion(id: string): [number, number] | null {
  const match = /^claude-[a-z]+-(\d+)(?:-(\d+))?(?:$|-\d{8})/.exec(
    id.split("/").pop() ?? id,
  );
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : null;
}
const atLeast = (id: string, major: number, minor: number) => {
  const version = claudeVersion(id);
  if (!version) return true;
  return version[0] > major || (version[0] === major && version[1] >= minor);
};

// Claude 4.6 and newer think adaptively at an effort level; older Claude models
// reject that and need token budgets instead.
export const adaptiveClaude = (id: string) => atLeast(id, 4, 6);

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
    const contextWindow = positiveTokens(entry.context);
    const maxTokens = positiveTokens(entry.output);
    if (contextWindow) data.contextWindow = contextWindow;
    if (maxTokens) data.maxTokens = maxTokens;
    if (entry.cost) data.cost = entry.cost;
    // Concentrate's Messages endpoint caches a Claude conversation as it grows,
    // with Pi marking each new turn. On Responses the cache falls behind during
    // tool loops and earlier tool results are written again at 1.25x price.
    // Claude before 4.5 stays on Responses: Bedrock rejects the field Pi adds to
    // budget thinking on those models through the Messages endpoint.
    if (isClaudeModel(entry.id) && atLeast(entry.id, 4, 5)) {
      data.api = "anthropic-messages";
      data.baseUrl = apiRoot;
    }
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
      if (data.api === "anthropic-messages" && adaptiveClaude(entry.id))
        data.compat = { forceAdaptiveThinking: true };
    }
    return data;
  });
  return {
    providers: {
      concentrate: {
        baseUrl: `${apiRoot}/v1`,
        // The Responses API, as in Concentrate's Pi guide. Chat Completions does
        // not cache Claude prompts, so every turn there pays full input price.
        api: "openai-responses",
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
  // Start from this Codex release's own model schema and instructions instead
  // of maintaining a hand-written approximation of it.
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
    const context = positiveTokens(item.context) ?? template.context_window;
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
