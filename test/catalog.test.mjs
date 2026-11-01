import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  ensureModel,
  fetchCatalog,
  modelsFor,
  summarize,
  validateKey,
} from "../dist/lib/catalog.js";
import { opencodeConfig, piConfig } from "../dist/lib/pickers.js";
import { tempDir } from "./helpers.mjs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });

const RAW = (id, extra = {}) => ({
  id,
  display_name: id.toUpperCase(),
  ...extra,
});

test("summarize maps integration flags and chat candidacy", () => {
  const model = summarize(
    RAW("m1", {
      integrations: {
        claude_code: { supported: true },
        codex: { supported: false },
      },
      providers: {
        a: {
          supports: {
            input: { text: true },
            tools: { function_calling: true },
          },
        },
      },
      max_input_tokens: 1000,
      capabilities: { image_input: { supported: true } },
    }),
  );
  assert.equal(model.claude, true);
  assert.equal(model.codex, false);
  assert.equal(model.chat_candidate, true);
  assert.equal(model.image, true);
  assert.equal(model.context, 1000);
  assert.equal(summarize({ name: "no id" }), null);
});

test("modelsFor filters by the tool's flag", () => {
  const models = [
    { id: "a", claude: true, codex: false, chat_candidate: false },
    { id: "gpt-b", claude: false, codex: true, chat_candidate: true },
  ];
  assert.deepEqual(
    modelsFor("claude", models).map((m) => m.id),
    ["a"],
  );
  assert.deepEqual(
    modelsFor("codex", models).map((m) => m.id),
    ["gpt-b"],
  );
  assert.deepEqual(
    modelsFor("pi", models).map((m) => m.id),
    ["gpt-b"],
  );
});

test("ensureModel appends a selected model that is missing and leaves present ones", () => {
  const models = [{ id: "a", name: "A" }];
  assert.equal(ensureModel(models, "a"), models);
  assert.deepEqual(
    ensureModel(models, "z").map((m) => m.id),
    ["a", "z"],
  );
});

test("fetchCatalog follows pagination, sorts by id, and caches", async () => {
  const env = { CN_CONFIG_HOME: tempDir() };
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return String(url).includes("after=b")
      ? json({ data: [RAW("a")], has_more: false })
      : json({ data: [RAW("c"), RAW("b")], has_more: true, last_id: "b" });
  };
  const first = await fetchCatalog({ env });
  assert.equal(first.source, "live");
  assert.deepEqual(
    first.models.map((m) => m.id),
    ["a", "b", "c"],
  );
  assert.equal(urls.length, 2);
  const second = await fetchCatalog({ env });
  assert.equal(second.source, "cache");
  assert.equal(urls.length, 2);
});

test("fetchCatalog falls back to a stale cache when the network fails", async () => {
  const env = { CN_CONFIG_HOME: tempDir() };
  globalThis.fetch = async () => json({ data: [RAW("a")], has_more: false });
  await fetchCatalog({ env });
  globalThis.fetch = async () => {
    throw new TypeError("network down");
  };
  const result = await fetchCatalog({ env, refresh: true });
  assert.equal(result.source, "stale cache");
});

test("fetchCatalog with no cache and no network throws a clear error", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("network down");
  };
  await assert.rejects(
    fetchCatalog({ env: { CN_CONFIG_HOME: tempDir() } }),
    /Could not fetch/,
  );
});

test("offline mode never touches the network", async () => {
  globalThis.fetch = async () => assert.fail("fetch must not be called");
  await assert.rejects(
    fetchCatalog({ env: { CN_CONFIG_HOME: tempDir(), CN_OFFLINE: "1" } }),
    /offline mode/,
  );
});

test("validateKey distinguishes a rejected key from other failures", async () => {
  globalThis.fetch = async () => json({}, 401);
  await assert.rejects(validateKey("bad"), /rejected this API key/);
  globalThis.fetch = async () => json({}, 503);
  await assert.rejects(validateKey("k"), /HTTP 503/);
  globalThis.fetch = async () => {
    throw new TypeError("offline");
  };
  await assert.rejects(validateKey("k"), /could not reach/);
  globalThis.fetch = async () => json({});
  await validateKey("good");
});

test("catalog text is made inert and unusable entries are dropped", () => {
  const evil = summarize({
    id: "ok-1",
    display_name: "Nice \u001b]52;c;Y3VybA==\u0007\u001b[2J\u202eName",
  });
  assert.equal(evil.name, "Nice ]52;c;Y3VybA==[2JName");
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u202e]/.test(evil.name));
  assert.equal(summarize({ id: "evil\u001b]0;x\u0007" }), null);
  assert.equal(summarize({ id: "--flag" }), null);
  assert.equal(
    summarize({ id: "m", display_name: 123, name: { a: 1 } }).name,
    "m",
  );
  assert.equal(
    summarize({ id: "m", max_input_tokens: "lots", max_tokens: -5 }).context,
    null,
  );
});

test("a malformed cache is filtered instead of crashing", async () => {
  const dir = tempDir();
  const { writeJson } = await import("../dist/lib/settings.js");
  writeJson(`${dir}/catalog.json`, {
    version: 5,
    fetchedAt: Date.now() / 1000,
    models: [
      null,
      7,
      { id: 3 },
      { id: "--x" },
      { id: "good", name: 123, claude: "yes" },
    ],
  });
  const { models } = await fetchCatalog({
    env: { CN_CONFIG_HOME: dir, CN_OFFLINE: "1" },
  });
  assert.deepEqual(
    models.map((m) => [m.id, m.name, m.claude]),
    [["good", "good", false]],
  );
});

test("reasoning metadata is provider-specific and conservative for automatic routing", () => {
  const supports = (effort) => ({
    input: { text: true },
    tools: { function_calling: true },
    reasoning: { effort },
  });
  const m = summarize(
    RAW("reasoner", {
      capabilities: { thinking: { supported: true } },
      providers: {
        a: {
          provider_slug: "a",
          supports: supports({
            none: true,
            low: true,
            medium: true,
            high: true,
          }),
        },
        b: {
          provider_slug: "b",
          supports: supports({
            none: true,
            low: true,
            medium: true,
            high: false,
          }),
        },
      },
    }),
  );
  assert.deepEqual(m.efforts, ["none", "low", "medium"]);
  assert.deepEqual(m.variants[0].efforts, ["none", "low", "medium", "high"]);
  assert.equal(m.reasoningSupport, true);
  assert.equal(summarize(RAW("unknown")).reasoningSupport, null);
  assert.equal(summarize(RAW("unknown")).efforts, null);
});

const catalogPage = () =>
  json({ data: [RAW("live-model")], has_more: false, last_id: null });

test("a catalog that was fetched is returned even when the cache cannot be written", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores directory modes");
  const fs = await import("node:fs");
  const dir = tempDir();
  fs.chmodSync(dir, 0o500);
  t.after(() => fs.chmodSync(dir, 0o700));
  globalThis.fetch = async () => catalogPage();
  const result = await fetchCatalog({ env: { CN_CONFIG_HOME: dir } });
  assert.equal(result.source, "live");
  assert.deepEqual(
    result.models.map((m) => m.id),
    ["live-model"],
  );
});

test("a cache from another format version is never served, even offline", async () => {
  const dir = tempDir();
  const { writeJson } = await import("../dist/lib/settings.js");
  writeJson(`${dir}/catalog.json`, {
    version: 1,
    fetchedAt: Date.now() / 1000,
    models: [{ id: "old-format" }],
  });
  await assert.rejects(
    fetchCatalog({ env: { CN_CONFIG_HOME: dir, CN_OFFLINE: "1" } }),
    /unavailable in offline mode/,
  );
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  await assert.rejects(
    fetchCatalog({ env: { CN_CONFIG_HOME: dir } }),
    /Could not fetch/,
  );
});

test("a cache dated in the future is refreshed rather than trusted forever", async () => {
  const dir = tempDir();
  const { writeJson } = await import("../dist/lib/settings.js");
  writeJson(`${dir}/catalog.json`, {
    version: 5,
    fetchedAt: 9e12,
    models: [{ id: "stale-model" }],
  });
  globalThis.fetch = async () => catalogPage();
  const result = await fetchCatalog({ env: { CN_CONFIG_HOME: dir } });
  assert.equal(result.source, "live");
  assert.deepEqual(
    result.models.map((m) => m.id),
    ["live-model"],
  );
});

test("catalog prices become dollars per million tokens for Pi", () => {
  const entry = summarize({
    id: "m",
    name: "M",
    providers: {
      p: {
        provider_slug: "p",
        pricing: [
          {
            tokens: {
              input: { price: { USD: 2 }, units: 1000000 },
              output: { price: { USD: 5 }, units: 500000 },
              cache: {
                read: { price: { USD: 0.1 }, units: 1000000 },
                write: {
                  ephemeral_5m_input_tokens: {
                    price: { USD: 2.5 },
                    units: 1000000,
                  },
                },
              },
            },
          },
        ],
      },
    },
  });
  assert.deepEqual(entry.cost, {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
  });
  assert.deepEqual(entry.variants[0].cost, entry.cost);
  const pi = piConfig("https://x", [entry]).providers.concentrate.models[0];
  assert.deepEqual(pi.cost, entry.cost);
  const price = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
  const old = opencodeConfig("https://x", "m", [entry]).provider.concentrate
    .models.m.cost;
  assert.deepEqual(old, {
    input: 2,
    output: 10,
    cache_read: 0.1,
    cache_write: 2.5,
  });
  const modern = opencodeConfig("https://x", "m", [entry], { modern: true })
    .providers.concentrate.models.m.cost;
  assert.deepEqual(modern, {
    input: price.input,
    output: price.output,
    cache: { read: 0.1, write: 2.5 },
  });
  assert.equal(summarize({ id: "n", name: "N" }).cost, null);
});

test("a cache from before prices is still used offline, but refreshed when online", async () => {
  const config = tempDir("cn-catalog-v3-");
  const env = { CN_CONFIG_HOME: config, CN_OFFLINE: "1" };
  fs.writeFileSync(
    path.join(config, "catalog.json"),
    JSON.stringify({
      version: 3,
      fetchedAt: Date.now() / 1000,
      models: [{ id: "old-model", name: "Old" }],
    }),
  );
  const { models, source } = await fetchCatalog({ env });
  assert.equal(source, "offline cache");
  assert.deepEqual(
    models.map((m) => m.id),
    ["old-model"],
  );
  assert.equal(models[0].cost, null);
});

test("prices come from the standard tier, with input-size tiers kept for Pi", () => {
  const tier = (condition, input, output) => ({
    ...(condition ? { condition } : {}),
    tokens: {
      input: { price: { USD: input }, units: 1000000 },
      output: { price: { USD: output }, units: 1000000 },
      cache: { read: { price: { USD: input / 10 }, units: 1000000 } },
    },
  });
  const now = Date.now();
  const entry = summarize({
    id: "m",
    name: "M",
    providers: {
      p: {
        provider_slug: "p",
        pricing: [
          tier({ service_tier: "fast" }, 8, 40),
          tier({ input_gte: 200000 }, 6, 30),
          tier({ date_gte: now + 86400000 }, 9, 9),
          tier({ date_gte: now - 86400000, description: "new price" }, 5, 25),
          tier(null, 4, 20),
        ],
      },
    },
  });
  assert.equal(entry.cost.input, 5, "the scheduled price that has started");
  assert.equal(entry.cost.output, 25);
  assert.deepEqual(entry.cost.tiers, [
    {
      input: 6,
      output: 30,
      cacheRead: 0.6,
      cacheWrite: 0,
      inputTokensAbove: 199999,
    },
  ]);
  const pi = piConfig("https://x", [entry]).providers.concentrate.models[0];
  assert.deepEqual(pi.cost.tiers, entry.cost.tiers);
});
