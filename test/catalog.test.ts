import fs from "node:fs";
import path from "node:path";
import { test, expect, onTestFinished, vi } from "vitest";

import {
  ensureModel,
  fetchCatalog,
  modelsFor,
  summarize,
  validateKey,
} from "../src/lib/catalog.js";
import { opencodeConfig, piConfig } from "../src/lib/pickers.js";
import { tempDir } from "./helpers.js";
import { writeJson } from "../src/lib/settings.js";

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
  expect(model.claude).toBe(true);
  expect(model.codex).toBe(false);
  expect(model.chat_candidate).toBe(true);
  expect(model.image).toBe(true);
  expect(model.context).toBe(1000);
  expect(summarize({ name: "no id" })).toBe(null);
});

test("modelsFor filters by the tool's flag", () => {
  const models = [
    { id: "a", claude: true, codex: false, chat_candidate: false },
    { id: "gpt-b", claude: false, codex: true, chat_candidate: true },
  ];
  expect(modelsFor("claude", models)).toMatchObject([{ id: "a" }]);
  expect(modelsFor("codex", models)).toMatchObject([{ id: "gpt-b" }]);
  expect(modelsFor("pi", models)).toMatchObject([{ id: "gpt-b" }]);
});

test("ensureModel appends a selected model that is missing and leaves present ones", () => {
  const models = [{ id: "a", name: "A" }];
  expect(ensureModel(models, "a")).toBe(models);
  expect(ensureModel(models, "z")).toMatchObject([{ id: "a" }, { id: "z" }]);
});

test("fetchCatalog follows pagination, sorts by id, and caches", async () => {
  const env = { CN_CONFIG_HOME: tempDir() };
  const urls = [];
  vi.stubGlobal("fetch", async (url) => {
    urls.push(String(url));
    return String(url).includes("after=b")
      ? json({ data: [RAW("a")], has_more: false })
      : json({ data: [RAW("c"), RAW("b")], has_more: true, last_id: "b" });
  });
  const first = await fetchCatalog({ env });
  expect(first.source).toBe("live");
  expect(first.models).toMatchObject([{ id: "a" }, { id: "b" }, { id: "c" }]);
  expect(urls.length).toBe(2);
  const second = await fetchCatalog({ env });
  expect(second.source).toBe("cache");
  expect(urls.length).toBe(2);
});

test("fetchCatalog falls back to a stale cache when the network fails", async () => {
  const env = { CN_CONFIG_HOME: tempDir() };
  vi.stubGlobal("fetch", async () =>
    json({ data: [RAW("a")], has_more: false }),
  );
  await fetchCatalog({ env });
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("network down");
  });
  const result = await fetchCatalog({ env, refresh: true });
  expect(result.source).toBe("stale cache");
});

test("fetchCatalog with no cache and no network throws a clear error", async () => {
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("network down");
  });
  await expect(
    fetchCatalog({ env: { CN_CONFIG_HOME: tempDir() } }),
  ).rejects.toThrow(/Could not fetch/);
});

test("offline mode never touches the network", async () => {
  vi.stubGlobal("fetch", async () => expect.fail("fetch must not be called"));
  await expect(
    fetchCatalog({ env: { CN_CONFIG_HOME: tempDir(), CN_OFFLINE: "1" } }),
  ).rejects.toThrow(/offline mode/);
});

test("validateKey distinguishes a rejected key from other failures", async () => {
  vi.stubGlobal("fetch", async () => json({}, 401));
  await expect(validateKey("bad")).rejects.toThrow(/rejected this API key/);
  vi.stubGlobal("fetch", async () => json({}, 503));
  await expect(validateKey("k")).rejects.toThrow(/HTTP 503/);
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("offline");
  });
  await expect(validateKey("k")).rejects.toThrow(/could not reach/);
  vi.stubGlobal("fetch", async () => json({}));
  await validateKey("good");
});

test("catalog text is made inert and unusable entries are dropped", () => {
  const evil = summarize({
    id: "ok-1",
    display_name: "Nice \u001b]52;c;Y3VybA==\u0007\u001b[2J\u202eName",
  });
  expect(evil.name).toBe("Nice ]52;c;Y3VybA==[2JName");
  expect(evil.name).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/);
  expect(summarize({ id: "evil\u001b]0;x\u0007" })).toBe(null);
  expect(summarize({ id: "--flag" })).toBe(null);
  expect(summarize({ id: "m", display_name: 123, name: { a: 1 } }).name).toBe(
    "m",
  );
  expect(
    summarize({ id: "m", max_input_tokens: "lots", max_tokens: -5 }).context,
  ).toBe(null);
});

test("a malformed cache is filtered instead of crashing", async () => {
  const dir = tempDir();
  writeJson(`${dir}/catalog.json`, {
    version: 6,
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
  expect(models).toMatchObject([{ id: "good", name: "good", claude: false }]);
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
  expect(m.efforts).toStrictEqual(["none", "low", "medium"]);
  expect(m.variants[0].efforts).toStrictEqual([
    "none",
    "low",
    "medium",
    "high",
  ]);
  expect(m.reasoningSupport).toBe(true);
  expect(summarize(RAW("unknown")).reasoningSupport).toBe(null);
  expect(summarize(RAW("unknown")).efforts).toBe(null);
});

const catalogPage = () =>
  json({ data: [RAW("live-model")], has_more: false, last_id: null });

test.skipIf(process.getuid?.() === 0)(
  "a catalog that was fetched is returned even when the cache cannot be written",
  async () => {
    const dir = tempDir();
    fs.chmodSync(dir, 0o500);
    onTestFinished(() => fs.chmodSync(dir, 0o700));
    vi.stubGlobal("fetch", async () => catalogPage());
    const result = await fetchCatalog({ env: { CN_CONFIG_HOME: dir } });
    expect(result.source).toBe("live");
    expect(result.models).toMatchObject([{ id: "live-model" }]);
  },
);

test("a cache from another format version is never served, even offline", async () => {
  const dir = tempDir();
  writeJson(`${dir}/catalog.json`, {
    version: 1,
    fetchedAt: Date.now() / 1000,
    models: [{ id: "old-format" }],
  });
  await expect(
    fetchCatalog({ env: { CN_CONFIG_HOME: dir, CN_OFFLINE: "1" } }),
  ).rejects.toThrow(/unavailable in offline mode/);
  vi.stubGlobal("fetch", async () => {
    throw new Error("network down");
  });
  await expect(fetchCatalog({ env: { CN_CONFIG_HOME: dir } })).rejects.toThrow(
    /Could not fetch/,
  );
});

test("a cache dated in the future is refreshed rather than trusted forever", async () => {
  const dir = tempDir();
  writeJson(`${dir}/catalog.json`, {
    version: 6,
    fetchedAt: 9e12,
    models: [{ id: "stale-model" }],
  });
  vi.stubGlobal("fetch", async () => catalogPage());
  const result = await fetchCatalog({ env: { CN_CONFIG_HOME: dir } });
  expect(result.source).toBe("live");
  expect(result.models).toMatchObject([{ id: "live-model" }]);
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
  expect(entry.cost).toStrictEqual({
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
  });
  expect(entry.variants[0].cost).toStrictEqual(entry.cost);
  const pi = piConfig("https://x", [entry]).providers.concentrate.models[0];
  expect(pi.cost).toStrictEqual(entry.cost);
  const price = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
  const old = opencodeConfig("https://x", "m", [entry]).provider.concentrate
    .models.m.cost;
  expect(old).toStrictEqual({
    input: 2,
    output: 10,
    cache_read: 0.1,
    cache_write: 2.5,
  });
  const modern = opencodeConfig("https://x", "m", [entry], { modern: true })
    .providers.concentrate.models.m.cost;
  expect(modern).toStrictEqual({
    input: price.input,
    output: price.output,
    cache: { read: 0.1, write: 2.5 },
  });
  expect(summarize({ id: "n", name: "N" }).cost).toBe(null);
});

test("cache-write prices are read under any field name, preferring Claude's 5-minute price", () => {
  const withWrite = (write) =>
    summarize({
      id: "m",
      name: "M",
      providers: {
        p: {
          provider_slug: "p",
          pricing: [
            {
              tokens: {
                input: { price: { USD: 2 }, units: 1000000 },
                output: { price: { USD: 10 }, units: 1000000 },
                cache: { read: { price: { USD: 0.1 }, units: 1000000 }, write },
              },
            },
          ],
        },
      },
    }).cost.cacheWrite;
  expect(
    withWrite({ cache_write_tokens: { price: { USD: 2.5 }, units: 1000000 } }),
  ).toBe(2.5);
  expect(
    withWrite({
      ephemeral_1h_input_tokens: { price: { USD: 4 }, units: 1000000 },
      ephemeral_5m_input_tokens: { price: { USD: 2.5 }, units: 1000000 },
    }),
  ).toBe(2.5);
  expect(withWrite(undefined)).toBe(0);
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
  expect(source).toBe("offline cache");
  expect(models).toMatchObject([{ id: "old-model" }]);
  expect(models[0].cost).toBe(null);
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
  expect(entry.cost.input, "the scheduled price that has started").toBe(5);
  expect(entry.cost.output).toBe(25);
  expect(entry.cost.tiers).toStrictEqual([
    {
      input: 6,
      output: 30,
      cacheRead: 0.6,
      cacheWrite: 0,
      inputTokensAbove: 199999,
    },
  ]);
  const pi = piConfig("https://x", [entry]).providers.concentrate.models[0];
  expect(pi.cost.tiers).toStrictEqual(entry.cost.tiers);
});
