import { EFFORTS } from "./model-metadata.js";
import type {
  Environment,
  HarnessId,
  Model,
  ModelCost,
  TokenPrices,
} from "./types.js";
import { isRecord, record, positiveTokens } from "./validation.js";
import path from "node:path";

import { CnError } from "./errors.js";
import { cleanText, isModelId, isOpenAiModel } from "./safe.js";
import { configDir, readJson, writeJson } from "./settings.js";

export const API_ROOT = "https://api.concentrate.ai";
const VALIDATION_MODEL = "deepseek-v4-1-flash";
const CACHE_SECONDS = 3600;
const MAX_PAGES = 10;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function requestJson(
  url: string,
  {
    headers = {},
    body,
    timeoutMs = 20000,
  }: {
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new HttpError(response.status);
  const result: unknown = await response.json();
  if (!isRecord(result)) throw new Error("Expected an API response object");
  return result;
}

export async function validateKey(key: string) {
  try {
    await requestJson(`${API_ROOT}/v1/responses`, {
      headers: { Authorization: `Bearer ${key}` },
      body: { model: VALIDATION_MODEL, input: "ping", max_output_tokens: 16 },
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      throw new CnError("Concentrate AI rejected this API key (HTTP 401)");
    }
    if (error instanceof HttpError) {
      throw new CnError(
        `Key check could not complete (HTTP ${error.status}). Try again or use --no-verify.`,
      );
    }
    throw new CnError(
      "Key check could not reach Concentrate AI. Try again or use --no-verify.",
    );
  }
}

const support = (provider: Record<string, unknown>, kind: string) =>
  record(record(provider.supports)[kind]);
const effortMap = (provider: Record<string, unknown>) =>
  record(support(provider, "reasoning").effort);

const perMillion = (entry: unknown) => {
  const { price, units } = record(entry);
  const usd = record(price).USD;
  return typeof usd === "number" &&
    typeof units === "number" &&
    usd >= 0 &&
    units > 0
    ? (usd / units) * 1_000_000
    : null;
};

function prices(tier: Record<string, unknown>): TokenPrices | null {
  const tokens = record(tier.tokens);
  const input = perMillion(tokens.input);
  const output = perMillion(tokens.output);
  if (input === null || output === null) return null;
  const cache = record(tokens.cache);
  return {
    input,
    output,
    cacheRead: perMillion(cache.read) ?? 0,
    cacheWrite: perMillion(record(cache.write).ephemeral_5m_input_tokens) ?? 0,
  };
}

// The keys of a pricing condition other than its human description.
const conditionKeys = (tier: Record<string, unknown>) =>
  Object.keys(record(tier.condition)).filter((key) => key !== "description");

// A provider's prices in dollars per million tokens. The base is the standard
// tier: no condition, or only a scheduled change that has already started.
// Opt-in tiers (fast, priority, peak hours) are left out; input-size tiers are
// kept so tools that support them can price long requests correctly.
function costOf(provider: Record<string, unknown>): ModelCost | null {
  const list = Array.isArray(provider.pricing)
    ? provider.pricing.map(record)
    : [];
  const now = Date.now();
  const startsAt = (tier: Record<string, unknown>) => {
    const value = record(tier.condition).date_gte;
    return typeof value === "number" ? value : 0;
  };
  const standard = list
    .filter((tier) => conditionKeys(tier).every((key) => key === "date_gte"))
    .filter((tier) => startsAt(tier) <= now)
    .sort((a, b) => startsAt(a) - startsAt(b))
    .at(-1);
  const base = standard ? prices(standard) : null;
  if (!base) return null;
  const tiers = list.flatMap((tier) => {
    const keys = conditionKeys(tier);
    const size = record(tier.condition).input_gte;
    const tierPrices = prices(tier);
    return keys.length === 1 &&
      keys[0] === "input_gte" &&
      typeof size === "number" &&
      size > 0 &&
      tierPrices
      ? [{ ...tierPrices, inputTokensAbove: size - 1 }]
      : [];
  });
  return tiers.length ? { ...base, tiers } : base;
}

// The catalog's release date (milliseconds) as YYYY-MM-DD.
function releaseDate(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString().slice(0, 10)
    : null;
}

function savedCost(value: unknown): ModelCost | null {
  const cost = record(value);
  const valid = (entry: Record<string, unknown>) =>
    [entry.input, entry.output, entry.cacheRead, entry.cacheWrite].every(
      (n) => typeof n === "number" && n >= 0,
    );
  if (!valid(cost)) return null;
  const base = {
    input: cost.input as number,
    output: cost.output as number,
    cacheRead: cost.cacheRead as number,
    cacheWrite: cost.cacheWrite as number,
  };
  const tiers = Array.isArray(cost.tiers)
    ? cost.tiers
        .map(record)
        .filter(
          (tier) =>
            valid(tier) &&
            typeof tier.inputTokensAbove === "number" &&
            tier.inputTokensAbove > 0,
        )
        .map((tier) => ({
          input: tier.input as number,
          output: tier.output as number,
          cacheRead: tier.cacheRead as number,
          cacheWrite: tier.cacheWrite as number,
          inputTokensAbove: tier.inputTokensAbove as number,
        }))
    : [];
  return tiers.length ? { ...base, tiers } : base;
}

function model(fields: Record<string, unknown>): Model {
  const efforts = Array.isArray(fields.efforts) ? fields.efforts : null;
  const id = isModelId(fields.id) ? fields.id : "";
  return {
    id,
    name: typeof fields.name === "string" ? cleanText(fields.name) || id : id,
    claude: fields.claude === true,
    codex: fields.codex === true,
    chat_candidate: fields.chat_candidate === true,
    context: positiveTokens(fields.context),
    output: positiveTokens(fields.output),
    image: fields.image === true,
    pdf: fields.pdf === true,
    released:
      typeof fields.released === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(fields.released)
        ? fields.released
        : null,
    reasoning: fields.reasoning === true,
    reasoningSupport:
      typeof fields.reasoningSupport === "boolean"
        ? fields.reasoningSupport
        : null,
    efforts: efforts
      ? EFFORTS.filter((level) => efforts.includes(level))
      : null,
    cost: savedCost(fields.cost),
  };
}

// Decode untrusted catalog fields before exposing the shared model contract.
export function summarize(value: unknown): Model | null {
  const raw = record(value);
  if (!isModelId(raw.id)) return null;
  const integrations = record(raw.integrations);
  const providers = Object.values(record(raw.providers)).filter(isRecord);
  const capabilities = record(raw.capabilities);
  const summary = model({
    id: raw.id,
    name:
      typeof raw.display_name === "string" && raw.display_name
        ? raw.display_name
        : raw.name,
    claude: record(integrations.claude_code).supported === true,
    codex: record(integrations.codex).supported === true,
    chat_candidate: providers.some(
      (p) =>
        support(p, "input").text === true &&
        support(p, "tools").function_calling === true,
    ),
    context: raw.max_input_tokens,
    output: raw.max_tokens,
    image: record(capabilities.image_input).supported === true,
    pdf: record(capabilities.pdf_input).supported === true,
    released: releaseDate(raw.release_date),
    reasoning: record(capabilities.thinking).supported === true,
    reasoningSupport: record(capabilities.thinking).supported,
    cost: providers.map(costOf).find(Boolean) ?? null,
    efforts:
      providers.length &&
      providers.every((p) => isRecord(support(p, "reasoning").effort))
        ? EFFORTS.filter((level) =>
            providers.every((p) => effortMap(p)[level] === true),
          )
        : null,
  });
  summary.variants = providers
    .filter((p) => isModelId(p.provider_slug) && isModelId(raw.slug || raw.id))
    .map((p) => {
      const efforts = effortMap(p);
      const reasoning = Object.entries(efforts).some(
        ([level, supported]) => level !== "none" && supported === true,
      );
      return model({
        ...summary,
        id: `${String(p.provider_slug)}/${String(raw.slug || raw.id)}`,
        name: `${summary.name} (${String(p.provider_slug)})`,
        chat_candidate:
          support(p, "input").text === true &&
          support(p, "tools").function_calling === true,
        context: p.context_window ?? summary.context,
        output: p.max_output_tokens ?? summary.output,
        image: Object.values(record(support(p, "input").image)).some(Boolean),
        pdf: record(support(p, "input").file).pdf === true,
        cost: costOf(p),
        reasoning,
        reasoningSupport: isRecord(support(p, "reasoning").effort)
          ? reasoning
          : null,
        efforts: isRecord(support(p, "reasoning").effort)
          ? EFFORTS.filter((level) => efforts[level] === true)
          : null,
      });
    })
    .filter((p) => isModelId(p.id));
  return summary;
}

function fromCache(value: unknown): Model | null {
  const entry = record(value);
  if (!isModelId(entry.id)) return null;
  return {
    ...model(entry),
    variants: Array.isArray(entry.variants)
      ? entry.variants
          .map(record)
          .filter((v) => isModelId(v.id))
          .map(model)
      : [],
  };
}

async function fetchAllPages() {
  const models: unknown[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = after ? `?after=${encodeURIComponent(after)}` : "";
    const result = await requestJson(`${API_ROOT}/v1/models${query}`);
    if (!Array.isArray(result.data)) throw new Error("invalid model catalog");
    models.push(...result.data);
    if (!result.has_more) return models;
    after = typeof result.last_id === "string" ? result.last_id : null;
    if (!after)
      throw new Error("model catalog pagination stopped without a cursor");
  }
  throw new Error("model catalog has more pages than expected");
}

export async function fetchCatalog({
  refresh = false,
  env = process.env,
}: { refresh?: boolean; env?: Environment } = {}) {
  const file = path.join(configDir(env), "catalog.json");
  let cached: Record<string, unknown> = {};
  try {
    cached = readJson(file, { private: false });
  } catch {
    cached = {};
  }
  // A cache written by another format version is not trustworthy, online or off.
  // Versions 3-5 lack fields added since (prices, PDF input, release dates), so
  // they are a fallback but never fresh.
  const current = cached.version === 6;
  const usable = current || [3, 4, 5].includes(Number(cached.version));
  const saved =
    usable && Array.isArray(cached.models)
      ? cached.models.map(fromCache).filter((m): m is Model => m !== null)
      : null;
  const age =
    Date.now() / 1000 -
    (typeof cached.fetchedAt === "number" ? cached.fetchedAt : 0);
  // A timestamp in the future (clock skew, a hand-edited file) is never fresh.
  const fresh = current && saved && age >= 0 && age < CACHE_SECONDS;
  if (!refresh && fresh) return { models: saved, source: "cache" };
  if (env.CN_OFFLINE === "1") {
    if (saved) return { models: saved, source: "offline cache" };
    throw new CnError("Model catalog is unavailable in offline mode");
  }
  let models: Model[];
  try {
    models = (await fetchAllPages())
      .map(summarize)
      .filter((m): m is Model => m !== null)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } catch {
    if (saved) return { models: saved, source: "stale cache" };
    throw new CnError("Could not fetch the Concentrate AI model catalog");
  }
  // The list is good even when it cannot be saved (read-only or full disk).
  try {
    writeJson(file, { version: 6, fetchedAt: Date.now() / 1000, models });
  } catch {
    /* The next run fetches again. */
  }
  return { models, source: "live" };
}

export function routingModels(models: Model[]) {
  return [...new Map(models.map((m) => [m.id, m])).values()];
}

export function modelsFor(harness: HarnessId, models: Model[]) {
  models = routingModels(models);
  if (harness === "claude") return models.filter((m) => m.claude);
  if (harness === "codex")
    return models.filter((m) => m.codex && isOpenAiModel(m.id));
  return models.filter((m) => m.chat_candidate);
}

// Normalize saved provider-specific choices when automatic routing is enabled.
export function routingModelId(models: Model[], selected: string) {
  return (
    models.find((m) => m.variants?.some((v) => v.id === selected))?.id ??
    selected
  );
}

export function ensureModel(models: Model[], selected: string): Model[] {
  if (models.some((m) => m.id === selected)) return models;
  return [...models, model({ id: selected, name: selected })];
}

export async function probeHarness(
  harness: HarnessId,
  model: string,
  key: string,
) {
  let url;
  let headers;
  let body;
  if (harness === "claude") {
    url = `${API_ROOT}/v1/messages`;
    headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
    body = {
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply OK." }],
    };
  } else {
    // Codex, OpenCode, and Pi all use the Responses API.
    url = `${API_ROOT}/v1/responses`;
    headers = { Authorization: `Bearer ${key}` };
    body = { model, input: "Reply OK.", max_output_tokens: 16 };
  }
  try {
    await requestJson(url, { headers, body, timeoutMs: 30000 });
  } catch (error) {
    if (error instanceof HttpError) {
      throw new CnError(
        `${harness} route returned HTTP ${error.status} for model ${model}`,
      );
    }
    throw new CnError(`${harness} route did not complete for model ${model}`);
  }
}
