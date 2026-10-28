import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  opencodeConfig,
  piConfig,
  writeCodexCatalog,
} from "../dist/lib/pickers.js";
import { fakeTool, tempDir } from "./helpers.mjs";

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

for (const modern of [false, true]) {
  test(`OpenCode ${modern ? "v2" : "v1"} receives distinct model limits and supported capabilities`, () => {
    const config = opencodeConfig("https://example.test", "small", models, {
      modern,
    });
    const catalog = (config.providers ?? config.provider).concentrate.models;
    assert.deepEqual(catalog.small.limit, { context: 32768, output: 4096 });
    assert.deepEqual(catalog.large.limit, { context: 400000, output: 64000 });
    assert.equal(catalog.unknown.limit, undefined);
    if (modern) {
      assert.deepEqual(catalog.small.capabilities.input, ["text"]);
      assert.deepEqual(catalog.large.capabilities.input, ["text", "image"]);
      assert.equal(catalog.small.capabilities.reasoning.supported, false);
      assert.deepEqual(catalog.large.capabilities.reasoning, {
        supported: true,
        effort: ["low", "medium", "max"],
        toggle: true,
      });
      assert.deepEqual(
        catalog.large.variants.map((entry) => entry.id),
        ["none", "low", "medium", "max"],
      );
      assert.equal(catalog.large.variants.at(-1).body.reasoning_effort, "max");
      assert.equal(catalog.unknown.capabilities.reasoning, undefined);
      assert.equal(catalog.large.modalities, undefined);
    } else {
      assert.equal(catalog.small.reasoning, false);
      assert.deepEqual(catalog.large.modalities.input, ["text", "image"]);
      assert.deepEqual(Object.keys(catalog.large.variants), [
        "none",
        "low",
        "medium",
        "max",
      ]);
      assert.equal(catalog.large.variants.max.reasoningEffort, "max");
      assert.equal(catalog.unknown.reasoning, undefined);
    }
  });
}

test("Pi limits and thinking choices follow each model without inventing missing metadata", () => {
  const [small, large, unknown] = piConfig("https://example.test", models)
    .providers.concentrate.models;
  assert.equal(small.contextWindow, 32768);
  assert.equal(small.maxTokens, 4096);
  assert.equal(small.reasoning, false);
  assert.equal(large.contextWindow, 400000);
  assert.equal(large.maxTokens, 64000);
  assert.deepEqual(large.thinkingLevelMap, {
    off: "none",
    minimal: null,
    low: "low",
    medium: "medium",
    high: null,
    xhigh: null,
    max: "max",
  });
  assert.equal(unknown.contextWindow, undefined);
  assert.equal(unknown.maxTokens, undefined);
  assert.equal(unknown.thinkingLevelMap, undefined);
  const mandatory = piConfig("https://example.test", [
    { ...models[1], efforts: ["high"] },
  ]).providers.concentrate.models[0];
  assert.equal(mandatory.thinkingLevelMap.off, null);
  assert.equal(mandatory.thinkingLevelMap.high, "high");
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
  assert.equal(small.context_window, 32768);
  assert.deepEqual(small.supported_reasoning_levels, []);
  assert.equal(large.context_window, 400000);
  assert.equal(large.max_context_window, 400000);
  assert.equal(large.shell_type, "unified_exec");
  assert.equal(large.base_instructions, "Bundled coding instructions");
  assert.deepEqual(large.future_catalog_field, { preserved: true });
  assert.equal(
    large.model_messages.instructions_template,
    "You are a coding agent. Use the tools.",
  );
  assert.equal(large.use_responses_lite, false);
  assert.equal(unknown.context_window, 272000);
  assert.deepEqual(
    large.supported_reasoning_levels.map((level) => level.effort),
    ["none", "low", "medium", "max"],
  );
  assert.equal(large.default_reasoning_level, "medium");
  assert.deepEqual(large.input_modalities, ["text", "image"]);
  assert.deepEqual(unknown.supported_reasoning_levels, []);
});

test("an unreadable bundled Codex catalog leaves the destination untouched", () => {
  const dir = tempDir();
  const executable = path.join(dir, "codex");
  const destination = path.join(dir, "models.json");
  fs.writeFileSync(destination, "previous catalog");
  fs.writeFileSync(executable, "#!/bin/sh\nprintf '%s' 'not JSON'\n", {
    mode: 0o755,
  });
  assert.throws(
    () => writeCodexCatalog(executable, models, destination),
    /bundled model catalog/,
  );
  assert.equal(fs.readFileSync(destination, "utf8"), "previous catalog");
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
  assert.equal(writeCodexCatalog(executable, models, destination), destination);
});
