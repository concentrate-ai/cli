import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import {
  opencodeConfig,
  piConfig,
  writeCodexCatalog,
} from "../src/lib/harnesses/pickers.js";
import { summarize } from "../src/lib/catalog.js";
import { fakeTool, tempDir } from "./helpers.js";

const models = [
  {
    id: "small",
    name: "Small",
    context: 32768,
    output: 4096,
    image: false,
    chat_candidate: true,
    reasoning: false,
    reasoningSupport: false,
    efforts: ["high"],
  },
  {
    id: "large",
    name: "Large",
    context: 400000,
    output: 64000,
    image: true,
    chat_candidate: true,
    reasoning: true,
    reasoningSupport: true,
    efforts: ["none", "low", "medium", "max"],
  },
  {
    id: "unknown",
    name: "Unknown",
    context: null,
    output: null,
    reasoningSupport: null,
    efforts: null,
  },
];

const expectLimits = (catalog) => {
  expect(catalog.small.limit).toStrictEqual({ context: 32768, output: 4096 });
  expect(catalog.large.limit).toStrictEqual({
    context: 400000,
    output: 64000,
  });
  expect(catalog.unknown.limit).toBe(undefined);
};

test("OpenCode v1 receives distinct model limits and supported capabilities", () => {
  const catalog = opencodeConfig("https://example.test", "small", models, {
    modern: false,
  }).provider.concentrate.models;
  expectLimits(catalog);
  expect(catalog.small.reasoning).toBe(false);
  expect(catalog.large.modalities.input).toStrictEqual(["text", "image"]);
  expect(Object.keys(catalog.large.variants)).toStrictEqual([
    "none",
    "low",
    "medium",
    "max",
  ]);
  expect(catalog.large.variants.max.reasoningEffort).toBe("max");
  expect(catalog.unknown.reasoning).toBe(undefined);
});

test("OpenCode v2 receives distinct model limits and supported capabilities", () => {
  const catalog = opencodeConfig("https://example.test", "small", models, {
    modern: true,
  }).providers.concentrate.models;
  expectLimits(catalog);
  expect(catalog.small.capabilities.input).toStrictEqual(["text"]);
  expect(catalog.large.capabilities.input).toStrictEqual(["text", "image"]);
  expect(catalog.small.capabilities.reasoning.supported).toBe(false);
  expect(catalog.large.capabilities.reasoning).toStrictEqual({
    supported: true,
    effort: ["low", "medium", "max"],
    toggle: true,
  });
  expect(catalog.large.variants).toMatchObject([
    { id: "none" },
    { id: "low" },
    { id: "medium" },
    { id: "max" },
  ]);
  expect(catalog.large.variants.at(-1).body.reasoning.effort).toBe("max");
  expect(catalog.unknown.capabilities.reasoning).toBe(undefined);
  expect(catalog.large.modalities).toBe(undefined);
});

test("Pi limits and thinking choices follow each model without inventing missing metadata", () => {
  const [small, large, unknown] = piConfig("https://example.test", models)
    .providers.concentrate.models;
  expect(small.contextWindow).toBe(32768);
  expect(small.maxTokens).toBe(4096);
  expect(small.reasoning).toBe(false);
  expect(large.contextWindow).toBe(400000);
  expect(large.maxTokens).toBe(64000);
  expect(large.thinkingLevelMap).toStrictEqual({
    off: "none",
    minimal: null,
    low: "low",
    medium: "medium",
    high: null,
    xhigh: null,
    max: "max",
  });
  expect(unknown.contextWindow).toBe(undefined);
  expect(unknown.maxTokens).toBe(undefined);
  expect(unknown.thinkingLevelMap).toBe(undefined);
  const mandatory = piConfig("https://example.test", [
    { ...models[1], efforts: ["high"] },
  ]).providers.concentrate.models[0];
  expect(mandatory.thinkingLevelMap.off).toBe(null);
  expect(mandatory.thinkingLevelMap.high).toBe("high");
});

test("Codex catalog advertises actual per-model reasoning choices and defaults", () => {
  const dir = tempDir();
  const executable = path.join(dir, "codex");
  fakeTool(dir, "codex");
  const file = writeCodexCatalog(
    executable,
    models,
    path.join(dir, "models.json"),
  );
  const [small, large, unknown] = JSON.parse(fs.readFileSync(file)).models;
  expect(small.context_window).toBe(32768);
  expect(small.supported_reasoning_levels).toStrictEqual([]);
  expect(large.context_window).toBe(400000);
  expect(large.max_context_window).toBe(400000);
  expect(large.shell_type).toBe("unified_exec");
  expect(large.base_instructions).toBe("Bundled coding instructions");
  expect(large.future_catalog_field).toStrictEqual({ preserved: true });
  expect(large.model_messages.instructions_template).toBe(
    "You are a coding agent. Use the tools.",
  );
  expect(large.use_responses_lite).toBe(false);
  expect(unknown.context_window).toBe(272000);
  expect(large.supported_reasoning_levels).toMatchObject([
    { effort: "none" },
    { effort: "low" },
    { effort: "medium" },
    { effort: "max" },
  ]);
  expect(large.default_reasoning_level).toBe("medium");
  expect(large.input_modalities).toStrictEqual(["text", "image"]);
  expect(unknown.supported_reasoning_levels).toStrictEqual([]);
});

test("an unreadable bundled Codex catalog leaves the destination untouched", () => {
  const dir = tempDir();
  const executable = path.join(dir, "codex");
  const destination = path.join(dir, "models.json");
  fs.writeFileSync(destination, "previous catalog");
  fs.writeFileSync(executable, "#!/bin/sh\nprintf '%s' 'not JSON'\n", {
    mode: 0o755,
  });
  expect(() => writeCodexCatalog(executable, models, destination)).toThrow(
    /bundled model catalog/,
  );
  expect(fs.readFileSync(destination, "utf8")).toBe("previous catalog");
});

test("Codex catalog validation accepts output larger than the subprocess buffer", () => {
  const dir = tempDir();
  const executable = path.join(dir, "codex");
  fs.writeFileSync(
    executable,
    `#!${process.execPath}\nif (process.argv.includes('--bundled')) console.log(JSON.stringify({models:[{slug:'gpt-5.5'}]})); else process.stdout.write('x'.repeat(2 * 1024 * 1024));\n`,
    { mode: 0o755 },
  );
  const destination = path.join(dir, "models.json");
  expect(writeCodexCatalog(executable, models, destination)).toBe(destination);
});

const claudeEntry = (id, efforts) => ({
  id,
  name: id,
  context: 200000,
  output: 64000,
  claude: true,
  codex: false,
  chat_candidate: true,
  image: false,
  reasoning: Boolean(efforts),
  reasoningSupport: efforts ? true : null,
  efforts,
});

test("Pi sends Claude to the Messages endpoint and everything else to Responses", () => {
  const provider = piConfig("https://gw.test", [
    claudeEntry("claude-opus-5-5", ["low", "high"]),
    claudeEntry("claude-sonnet-4-5", ["none", "low", "high"]),
    { ...claudeEntry("gpt-6.1-terra", ["low", "high"]), claude: false },
  ]).providers.concentrate;
  expect(provider.api).toBe("openai-responses");
  const [opus, sonnet, gpt] = provider.models;
  expect(opus.api).toBe("anthropic-messages");
  expect(opus.baseUrl).toBe("https://gw.test");
  expect(opus.compat).toStrictEqual({ forceAdaptiveThinking: true });
  expect(sonnet.compat, "Claude before 4.6 uses budgets").toBe(undefined);
  expect(gpt.api).toBe(undefined);
  const [old] = piConfig("https://gw.test", [
    claudeEntry("claude-opus-4-1", ["low", "high"]),
  ]).providers.concentrate.models;
  expect(old.api, "Claude before 4.5 stays on Responses").toBe(undefined);
});

test("OpenCode sends Claude through its Anthropic package in both versions", () => {
  const models = [
    claudeEntry("claude-opus-5-5", ["low", "high"]),
    claudeEntry("claude-sonnet-4-5", ["none", "high"]),
    { ...claudeEntry("gpt-6.1-terra", ["low", "high"]), claude: false },
  ];
  const modern = opencodeConfig("https://gw.test", "claude-opus-5-5", models, {
    modern: true,
  }).providers.concentrate;
  expect(modern.package).toBe("@opencode/ai/providers/openai");
  const opus = modern.models["claude-opus-5-5"];
  expect(opus.package).toBe("@opencode/ai/providers/anthropic");
  expect(opus.settings).toStrictEqual({ baseURL: "https://gw.test/v1" });
  expect(opus.variants[1]).toStrictEqual({
    id: "high",
    body: { output_config: { effort: "high" } },
  });
  expect(modern.models["claude-sonnet-4-5"].variants).toStrictEqual([
    { id: "none", body: { thinking: { type: "disabled" } } },
    {
      id: "high",
      body: { thinking: { type: "enabled", budget_tokens: 16384 } },
    },
  ]);
  expect(modern.models["gpt-6.1-terra"].package).toBe(undefined);
  expect(modern.models["gpt-6.1-terra"].variants[1].body).toStrictEqual({
    reasoning: { effort: "high" },
  });
  const legacy = opencodeConfig("https://gw.test", "claude-opus-5-5", models)
    .provider.concentrate;
  expect(legacy.npm).toBe("@ai-sdk/openai");
  expect(legacy.models["claude-opus-5-5"].provider).toStrictEqual({
    npm: "@ai-sdk/anthropic",
  });
  expect(legacy.models["claude-opus-5-5"].variants.high).toStrictEqual({
    effort: "high",
  });
  expect(legacy.models["claude-sonnet-4-5"].variants.high).toStrictEqual({
    thinking: { type: "enabled", budgetTokens: 16384 },
  });
  expect(legacy.models["gpt-6.1-terra"].provider).toBe(undefined);
});

test("OpenCode gets tool calling, PDF input and release dates in each version's field names", () => {
  const raw = summarize({
    id: "m",
    name: "M",
    release_date: Date.UTC(2026, 8, 22),
    capabilities: {
      image_input: { supported: true },
      pdf_input: { supported: true },
    },
    providers: {
      p: {
        provider_slug: "p",
        supports: {
          input: { text: true, image: { png: true }, file: { pdf: true } },
          tools: { function_calling: true },
        },
      },
    },
  });
  expect(raw.released).toBe("2026-09-22");
  expect(raw.variants[0].pdf).toBe(true);
  const legacy = opencodeConfig("https://gw.test", "m", [raw]).provider
    .concentrate.models.m;
  expect(legacy.tool_call).toBe(true);
  expect(legacy.toolcall).toBe(undefined);
  expect(legacy.release_date).toBe("2026-09-22");
  expect(legacy.modalities.input).toStrictEqual(["text", "image", "pdf"]);
  const modern = opencodeConfig("https://gw.test", "m", [raw], { modern: true })
    .providers.concentrate.models.m;
  expect(modern.releaseDate).toBe("2026-09-22");
  expect(modern.capabilities.input).toStrictEqual(["text", "image", "pdf"]);
});
