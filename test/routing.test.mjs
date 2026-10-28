import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  modelsFor,
  routingModels,
  summarize,
  fetchCatalog,
} from "../dist/lib/catalog.js";
import {
  DEFAULT_MODELS,
  readPreferences,
  readJson,
  writeJson,
  writePreferences,
} from "../dist/lib/settings.js";
import { menuItems } from "../dist/lib/launcher.js";
import { CODEX_TEMPLATE, runCn, tempDir } from "./helpers.mjs";

const provider = (slug, context = 1000) => ({
  provider_slug: slug,
  context_window: context,
  max_output_tokens: 100,
  supports: {
    input: { text: true, image: { png: true } },
    tools: { function_calling: true },
    reasoning: { effort: { high: true } },
  },
});
const raw = (id) => ({
  id,
  slug: id,
  name: id,
  integrations: {
    claude_code: { supported: true },
    codex: { supported: true },
  },
  providers: { a: provider("a"), b: provider("b", 2000) },
});
const models = [summarize(raw("gpt-m1")), summarize(raw("gpt-m2"))];

test("retired routing preference is ignored and removed on the next model save", () => {
  const env = { CN_CONFIG_HOME: tempDir() };
  const file = path.join(env.CN_CONFIG_HOME, "config.json");
  writeJson(file, {
    autoProvider: false,
    models: { ...DEFAULT_MODELS, pi: "a/gpt-m1" },
  });
  assert.equal(readPreferences(env).pi, "a/gpt-m1");
  writePreferences({ ...DEFAULT_MODELS, pi: "gpt-m2" }, env);
  assert.equal(readPreferences(env).pi, "gpt-m2");
  assert.equal(Object.hasOwn(readJson(file), "autoProvider"), false);
});

test("catalog exposes unique slugs for every tool and retains provider metadata internally", () => {
  assert.deepEqual(
    routingModels(models).map((m) => m.id),
    ["gpt-m1", "gpt-m2"],
  );
  for (const harness of Object.keys(DEFAULT_MODELS)) {
    assert.deepEqual(
      modelsFor(harness, models).map((m) => m.id),
      ["gpt-m1", "gpt-m2"],
    );
  }
  assert.equal(models[0].variants[1].context, 2000);
  assert.equal(models[0].variants[0].image, true);
  assert.equal(models[0].variants[0].reasoning, true);
  assert.deepEqual(
    routingModels([models[0], models[0]]).map((m) => m.id),
    ["gpt-m1"],
  );
});

test("provider entries survive cache round trips and old cache is refreshed", async () => {
  const env = { CN_CONFIG_HOME: tempDir() };
  writeJson(path.join(env.CN_CONFIG_HOME, "catalog.json"), {
    fetchedAt: Date.now() / 1000,
    models: [{ id: "old" }],
  });
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [raw("gpt-m1")], has_more: false }));
    assert.equal((await fetchCatalog({ env })).source, "live");
    const cached = await fetchCatalog({ env: { ...env, CN_OFFLINE: "1" } });
    assert.deepEqual(
      modelsFor("pi", cached.models).map((m) => m.id),
      ["gpt-m1"],
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("routing toggle is absent from commands, help, and launcher", () => {
  const env = { CN_CONFIG_HOME: tempDir() };
  assert.equal(runCn(["settings"], { env }).status, 0);
  assert.doesNotMatch(runCn(["--help"], { env }).stdout, /auto-provider/);
  assert.equal(
    menuItems(env).items.some((item) => item.value === "settings"),
    true,
  );
});

for (const harness of Object.keys(DEFAULT_MODELS)) {
  for (const legacyPreference of [true, false]) {
    test(`${harness} receives the automatic catalog despite legacy autoProvider=${legacyPreference} and matching launch model`, () => {
      const dir = tempDir();
      const env = {
        CN_CONFIG_HOME: dir,
        PI_CODING_AGENT_DIR: path.join(dir, "source"),
        PATH: `${dir}:${path.dirname(process.execPath)}`,
        CONCENTRATE_API_KEY: "sk-test",
      };
      writeJson(path.join(dir, "catalog.json"), {
        version: 3,
        fetchedAt: Date.now() / 1000,
        models,
      });
      writeJson(path.join(dir, "config.json"), {
        autoProvider: legacyPreference,
      });
      // Saved pinned choices normalize to the slug in automatic mode.
      writePreferences(
        Object.fromEntries(
          Object.keys(DEFAULT_MODELS).map((h) => [h, "a/gpt-m1"]),
        ),
        env,
      );
      const config = path.join(dir, "config.json");
      writeJson(config, {
        ...readJson(config),
        autoProvider: legacyPreference,
      });
      fs.writeFileSync(
        path.join(dir, harness),
        `#!/usr/bin/env node
const fs = require('node:fs'), p = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--bundled')) { console.log(JSON.stringify({models:[${JSON.stringify(CODEX_TEMPLATE)}]})); process.exit(0); }
if (args.includes('debug') || args.includes('--help')) process.exit(0);
let catalog;
if (${JSON.stringify(harness)} === 'pi') catalog = JSON.parse(fs.readFileSync(p.join(process.env.PI_CODING_AGENT_DIR, 'models.json'))).providers.concentrate.models.map(m=>m.id);
if (${JSON.stringify(harness)} === 'opencode') catalog = Object.keys(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).provider.concentrate.models);
if (${JSON.stringify(harness)} === 'claude') { const settings=JSON.parse(args[1]); catalog=settings.modelPicker.options.map(m=>m.model); if (!settings.modelPicker.replaceBuiltInOptions) process.exit(4); }
if (${JSON.stringify(harness)} === 'codex') { const flag=args.find(a=>a.startsWith('model_catalog_json=')); catalog=JSON.parse(fs.readFileSync(JSON.parse(flag.slice('model_catalog_json='.length)))).models.map(m=>m.slug); }
console.log(JSON.stringify({ args, catalog }));`,
        { mode: 0o755 },
      );
      const result = runCn([harness], { env });
      assert.equal(result.status, 0, result.stderr);
      const actual = JSON.parse(result.stdout);
      const expected = ["gpt-m1", "gpt-m2"];
      assert.deepEqual([...actual.catalog].sort(), [...expected].sort());
      assert.ok(actual.args.includes("gpt-m1") || harness === "opencode");
    });
  }
}
