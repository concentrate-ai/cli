import fs from "node:fs";
import path from "node:path";
import { test, expect, vi } from "vitest";
import {
  modelsFor,
  routingModels,
  summarize,
  fetchCatalog,
} from "../src/lib/catalog.js";
import {
  DEFAULT_MODELS,
  readPreferences,
  readJson,
  writeJson,
  writePreferences,
} from "../src/lib/settings.js";
import { menuItems } from "../src/lib/launcher.js";
import { CODEX_TEMPLATE, runCn, tempDir } from "./helpers.js";

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
const harnesses = Object.keys(DEFAULT_MODELS);

test("retired routing preference is ignored and removed on the next model save", () => {
  const env = { CN_CONFIG_HOME: tempDir() };
  const file = path.join(env.CN_CONFIG_HOME, "config.json");
  writeJson(file, {
    autoProvider: false,
    models: { ...DEFAULT_MODELS, pi: "a/gpt-m1" },
  });
  expect(readPreferences(env).pi).toBe("a/gpt-m1");
  writePreferences({ ...DEFAULT_MODELS, pi: "gpt-m2" }, env);
  expect(readPreferences(env).pi).toBe("gpt-m2");
  expect(Object.hasOwn(readJson(file), "autoProvider")).toBe(false);
});

test("catalog exposes unique slugs for every tool and retains provider metadata internally", () => {
  expect(routingModels(models)).toMatchObject([
    { id: "gpt-m1" },
    { id: "gpt-m2" },
  ]);
  expect(models[0].variants[1].context).toBe(2000);
  expect(models[0].variants[0].image).toBe(true);
  expect(models[0].variants[0].reasoning).toBe(true);
  expect(routingModels([models[0], models[0]])).toMatchObject([
    { id: "gpt-m1" },
  ]);
});

test.each(harnesses)(
  "catalog exposes unique slugs for every tool and retains provider metadata internally: %s",
  (harness) => {
    expect(modelsFor(harness, models)).toMatchObject([
      { id: "gpt-m1" },
      { id: "gpt-m2" },
    ]);
  },
);

test("provider entries survive cache round trips and old cache is refreshed", async () => {
  const env = { CN_CONFIG_HOME: tempDir() };
  writeJson(path.join(env.CN_CONFIG_HOME, "catalog.json"), {
    fetchedAt: Date.now() / 1000,
    models: [{ id: "old" }],
  });
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ data: [raw("gpt-m1")], has_more: false })),
  );
  expect((await fetchCatalog({ env })).source).toBe("live");
  const cached = await fetchCatalog({ env: { ...env, CN_OFFLINE: "1" } });
  expect(modelsFor("pi", cached.models)).toMatchObject([{ id: "gpt-m1" }]);
});

test("routing toggle is absent from commands, help, and launcher", () => {
  const env = { CN_CONFIG_HOME: tempDir() };
  expect(runCn(["settings"], { env }).status).toBe(0);
  expect(runCn(["--help"], { env }).stdout).not.toMatch(/auto-provider/);
  expect(menuItems(env).items).toContainEqual(
    expect.objectContaining({ value: "settings" }),
  );
});

const pinned = Object.fromEntries(harnesses.map((h) => [h, "a/gpt-m1"]));
const launchCases = harnesses.flatMap((harness) => [
  [harness, true],
  [harness, false],
]);

test.each(launchCases)(
  "%s receives the automatic catalog despite legacy autoProvider=%s and matching launch model",
  (harness, legacyPreference) => {
    const dir = tempDir();
    const env = {
      CN_CONFIG_HOME: dir,
      PI_CODING_AGENT_DIR: path.join(dir, "source"),
      PATH: `${dir}:${path.dirname(process.execPath)}`,
      CONCENTRATE_API_KEY: "sk-test",
    };
    writeJson(path.join(dir, "catalog.json"), {
      version: 6,
      fetchedAt: Date.now() / 1000,
      models,
    });
    writeJson(path.join(dir, "config.json"), {
      autoProvider: legacyPreference,
    });
    // Saved pinned choices normalize to the slug in automatic mode.
    writePreferences(pinned, env);
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
    expect(result.status, result.stderr).toBe(0);
    const actual = JSON.parse(result.stdout);
    expect([...actual.catalog].sort()).toStrictEqual(["gpt-m1", "gpt-m2"]);
    expect(actual.args.includes("gpt-m1")).toBe(harness !== "opencode");
  },
);
