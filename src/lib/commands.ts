import { listConfigurableTools } from "./configurable-tools.js";
import type {
  Environment,
  Harness,
  HarnessId,
  Model,
  TerminalCapabilities,
} from "./types.js";
import {
  ensureModel,
  fetchCatalog,
  modelsFor,
  routingModels,
  routingModelId,
  probeHarness,
  validateKey,
} from "./catalog.js";
import {
  configureTool,
  resetTool,
  toolConfigured,
  refreshConfiguredKey,
} from "./tool-config.js";
import { CnError } from "./errors.js";
import { isApiKey } from "./safe.js";
import { getHarness, listHarnesses } from "./harnesses/registry.js";
import { which } from "./launch.js";
import { ask, askHidden } from "./prompt.js";
import {
  configDir,
  deleteStoredKey,
  HARNESS_IDS,
  readPreferences,
  environmentKey,
  readStoredKey,
  resetState,
  resetTargets,
  resolveKey,
  writeKey,
  writePreferences,
} from "./settings.js";
import { focusIn, header } from "./ui/brand.js";
import { ledger, panel } from "./ui/layout.js";
import { modelItem, modelLegend, modelRight } from "./ui/models.js";
import { caps, pad, paint } from "./ui/term.js";
import { glyphs } from "./ui/theme.js";
import { interactive, password, select, spinner } from "./ui/widgets.js";
import { version } from "./version.js";

const SUGGESTED_MODELS = ["claude-sonnet-4-6", "deepseek-v4-1-flash"];

// ---- helpers shared by commands -------------------------------------------------

// Runs `work` under a spinner and prints one ledger line when it succeeds.
async function step<T>(
  running: string,
  label: string,
  work: () => Promise<T>,
  done: string | ((value: T) => string),
) {
  const spin = spinner(running);
  try {
    const result = await work();
    spin.succeed(
      ledger("ok", label, typeof done === "function" ? done(result) : done),
    );
    return result;
  } catch (error) {
    spin.stop();
    throw error;
  }
}

function matches(models: Model[], query: string) {
  const needle = query.toLowerCase();
  return models.filter(
    (m) =>
      m.id.toLowerCase().includes(needle) ||
      m.name.toLowerCase().includes(needle),
  );
}

// Plain numbered prompt: used when stdin or stdout is not a terminal.
async function promptModelPlain(
  harnessId: HarnessId,
  current: string,
  catalog: Model[],
  _env: Environment,
) {
  current = routingModelId(catalog, current);
  const available = modelsFor(harnessId, catalog);
  const byId = new Map(available.map((m) => [m.id, m]));
  const suggestions = [
    ...new Set(
      [current, ...SUGGESTED_MODELS, ...available.map((m) => m.id)].filter(
        (id) => id === current || byId.has(id),
      ),
    ),
  ].slice(0, 5);
  console.log(`\n${getHarness(harnessId).label} default model`);
  suggestions.forEach((id, index) =>
    console.log(`  ${index + 1}) ${id}${index === 0 ? " (current)" : ""}`),
  );
  console.log("Type a model ID or ?search to browse the catalog.");
  for (;;) {
    const answer = await ask(`Select [Enter keeps ${current}]: `);
    if (!answer) return current;
    if (/^\d+$/.test(answer)) {
      const picked = suggestions[Number(answer) - 1];
      if (picked) return picked;
      console.log("Enter a listed number, model ID, or ?search.");
      continue;
    }
    if (answer.startsWith("?")) {
      const found = matches(available, answer.slice(1).trim());
      for (const item of found.slice(0, 20))
        console.log(`  ${item.id} - ${item.name}`);
      console.log(
        `${found.length} matches${found.length > 20 ? " (showing 20)" : ""}`,
      );
      continue;
    }
    if (available.length && !byId.has(answer)) {
      console.log("That ID is not in this tool's catalog; it may still work.");
    }
    return routingModelId(catalog, answer);
  }
}

async function chooseModel(
  harnessId: HarnessId,
  current: string,
  catalog: Model[],
  env: Environment,
) {
  if (!interactive()) return promptModelPlain(harnessId, current, catalog, env);
  const c = caps();
  current = routingModelId(catalog, current);
  const candidates = modelsFor(harnessId, catalog);
  const available = ensureModel(candidates, current);
  const result = await select({
    title: `${getHarness(harnessId).label}  ${paint("mute", "default model", {}, c)}`,
    items: available.map((model) => modelItem(model, c)),
    initial: current,
    filterable: true,
    allowCustom: true,
    rows: 9,
    legend: modelLegend(c),
    hints: [
      ["↑↓", "move"],
      ["↵", "choose"],
      ["type", "filter"],
      ["esc", `keep ${current}`],
    ],
  });
  if (result.cancel) return current;
  return routingModelId(catalog, result.value);
}

async function promptKey(existing: string | null, inherited: string | null) {
  const fallback = existing || inherited;
  const placeholder = existing
    ? "Enter keeps the saved key"
    : inherited
      ? "Enter saves CONCENTRATE_API_KEY"
      : "paste your key";
  const entered = interactive()
    ? await password({ label: "API key", placeholder })
    : await askHidden("Concentrate AI key (hidden): ");
  const key = entered || fallback;
  if (!key) throw new CnError("API key is required");
  if (!isApiKey(key))
    throw new CnError(
      "That doesn't look like an API key: it has spaces or control characters.",
    );
  return key;
}

export function maskKey(key: string) {
  const tail = key.length >= 12 ? key.slice(-4) : "";
  return "•".repeat(8) + tail;
}

// Offers a key that is already around instead of asking for it again. A key
// found only in the environment is used in place and not copied to disk.
async function chooseKey(env: Environment) {
  const stored = readStoredKey(env);
  const fromEnv = environmentKey(env);
  const found = stored || fromEnv;
  if (interactive(env) && found) {
    const c = caps();
    const choice = await select({
      title: `Found a Concentrate AI key ${paint("mute", stored ? "saved by cn" : "in your environment", {}, c)}`,
      items: [
        {
          value: "use",
          label: "Use this key",
          note: maskKey(found),
          tone: "focus",
        },
        { value: "new", label: "Paste a different key" },
      ],
      hints: [
        ["↑↓", "move"],
        ["↵", "choose"],
        ["esc", "cancel"],
      ],
    });
    if (choice.cancel) throw new CnError("Cancelled", 130);
    if (choice.value === "use") return { key: found, persist: Boolean(stored) };
    return { key: await promptKey(null, null), persist: true };
  }
  const key = await promptKey(stored, fromEnv);
  return { key, persist: key !== fromEnv || Boolean(stored) };
}

// ---- commands ---------------------------------------------------------------------

export async function runSetup(
  { verify = true, showHeader = true, models: customize = false } = {},
  env: Environment = process.env,
) {
  const c = caps();
  if (showHeader && interactive(env)) {
    await focusIn(c);
    console.log(header(version(), {}, c).join("\n") + "\n");
  } else if (showHeader) {
    console.log("Concentrate AI setup\n");
  }
  const { key, persist } = await chooseKey(env);
  if (verify) {
    await step("checking the key", "key", () => validateKey(key), "verified");
  } else {
    console.log(ledger("warn", "key", "saved without a live check", c));
  }
  const models = readPreferences(env);
  if (customize) {
    let catalog: Model[] = [];
    try {
      const result = await step(
        "fetching the catalog",
        "catalog",
        () => fetchCatalog({ env }),
        (r) =>
          `${r.models.length} models ${paint("mute", `(${r.source})`, {}, c)}`,
      );
      catalog = result.models;
    } catch {
      console.log(
        ledger(
          "warn",
          "catalog",
          "unavailable; you can still type model IDs",
          c,
        ),
      );
    }
    for (const id of HARNESS_IDS) {
      models[id] = await chooseModel(id, models[id], catalog, env);
      console.log(
        ledger("ok", getHarness(id as HarnessId).label, models[id], c),
      );
    }
    writePreferences(models, env);
  }
  if (persist) {
    writeKey(key, env);
    refreshConfiguredKey(env);
  }
  const g = glyphs(c);
  console.log();
  for (const line of panel(
    "ready",
    [
      ...HARNESS_IDS.map(
        (id) =>
          `${paint("focus", g.info, {}, c)} ${pad(`cn ${id}`, 9)} ${paint("mute", models[id], {}, c)}`,
      ),
      "",
      paint("mute", "change a default: cn model <tool>", {}, c),
    ],
    c,
  ))
    console.log(line);
  return 0;
}

export async function runKey(
  { verify = true } = {},
  env: Environment = process.env,
) {
  const key = await promptKey(readStoredKey(env), environmentKey(env));
  if (verify)
    await step("checking the key", "key", () => validateKey(key), "verified");
  writeKey(key, env);
  refreshConfiguredKey(env);
  console.log(
    ledger(
      verify ? "ok" : "warn",
      "saved",
      verify ? "key stored" : "key stored without a live check",
    ),
  );
  return 0;
}

export function runLogout(env: Environment = process.env) {
  for (const id of ["opencode", "cursor"] as const) {
    if (!toolConfigured(id, env)) continue;
    const result = resetTool(id, env);
    for (const field of result.preserved)
      console.log(ledger("warn", "kept edit", field));
    console.log(
      ledger(
        "info",
        id === "cursor" ? "Cursor desktop" : "OpenCode",
        "saved integration reset to remove its native copy of the key",
      ),
    );
  }
  console.log(
    deleteStoredKey(env)
      ? ledger("ok", "logout", "saved key removed")
      : ledger("mute", "logout", "no saved key found"),
  );
  if (env.CONCENTRATE_API_KEY) {
    console.log(
      ledger(
        "warn",
        "environment",
        "CONCENTRATE_API_KEY is still set and can still be used",
      ),
    );
  }
  return 0;
}

export async function runReset(
  { yes = false, sessions = false } = {},
  env: Environment = process.env,
) {
  const c = caps();
  const targets = resetTargets(env, { sessions });
  const configured = listConfigurableTools().filter((tool) =>
    toolConfigured(tool.id, env),
  );
  if (!targets.length && !configured.length) {
    console.log(ledger("mute", "reset", "nothing saved, already fresh", c));
    return 0;
  }
  if (!yes) {
    if (!interactive(env))
      throw new CnError(
        "Reset removes your saved key and models and restores configured tools. Pass --yes to confirm.",
        2,
      );
    const names = targets.map((target) => target.split("/").pop()).join(", ");
    const choice = await select({
      title: `Reset cn?  ${paint("mute", names, {}, c)}`,
      items: [
        { value: "no", label: "Keep everything" },
        {
          value: "yes",
          label: "Reset",
          note: "restores configured tools, then removes cn’s key, models, and cache",
          tone: "bad",
        },
      ],
      hints: [
        ["↑↓", "move"],
        ["↵", "choose"],
        ["esc", "cancel"],
      ],
    });
    if (choice.cancel || choice.value !== "yes") {
      console.log(ledger("mute", "reset", "cancelled, nothing changed", c));
      return 0;
    }
  }
  for (const tool of configured) {
    const result = resetTool(tool.id, env);
    for (const field of result.preserved)
      console.log(ledger("warn", "kept edit", field));
    console.log(ledger("ok", tool.label, "saved integration reset"));
  }
  for (const target of resetState(env, { sessions })) {
    console.log(ledger("ok", "removed", target.split("/").pop(), c));
  }
  if (!sessions)
    console.log(
      ledger(
        "mute",
        "kept",
        "Pi sessions (use --sessions to remove them too)",
        c,
      ),
    );
  if (env.CONCENTRATE_API_KEY) {
    console.log(
      ledger(
        "warn",
        "environment",
        "CONCENTRATE_API_KEY is still set in your shell",
        c,
      ),
    );
  }
  console.log(`\n  ${paint("mute", "Run cn to set up again.", {}, c)}`);
  return 0;
}

export function showConfig(env: Environment = process.env) {
  const { key, source } = resolveKey(env);
  console.log(ledger("mute", "config", configDir(env)));
  console.log(ledger(key ? "ok" : "bad", "api key", source));
  console.log(ledger("info", "routing", "automatic"));
  for (const [id, model] of Object.entries(readPreferences(env))) {
    console.log(
      ledger(
        "info",
        getHarness(id as HarnessId).label,
        `${model}${toolConfigured(id as HarnessId, env) ? " (configured permanently)" : ""}`,
      ),
    );
  }
  return 0;
}

export async function runModel(
  { target, modelId }: { target?: HarnessId; modelId?: string },
  env: Environment = process.env,
) {
  if (!target) return showConfig(env);
  const models = readPreferences(env);
  if (modelId) {
    models[target] = modelId;
  } else {
    let catalog: Model[] = [];
    try {
      catalog = (await fetchCatalog({ env })).models;
    } catch {
      // continue with an empty catalog; the user can still type an ID
    }
    models[target] = await chooseModel(target, models[target], catalog, env);
  }
  writePreferences(models, env);
  if (toolConfigured(target, env)) {
    try {
      await configureTool(target, env);
    } catch {
      console.log(
        ledger(
          "warn",
          "native config",
          "default saved in cn; refresh this tool’s Configure action to update its native settings",
        ),
      );
    }
  }
  console.log(
    ledger("ok", getHarness(target).label, `default model ${models[target]}`),
  );
  return 0;
}

export async function showModels(
  {
    target,
    search,
    refresh,
    limit,
  }: { target?: HarnessId; search?: string; refresh?: boolean; limit: number },
  env: Environment = process.env,
) {
  const { models, source } = await fetchCatalog({ refresh, env });
  let candidates = target ? modelsFor(target, models) : routingModels(models);
  if (search) candidates = matches(candidates, search);
  const c = caps();
  console.log(`${candidates.length} models (${source})`);
  const width = Math.max(
    0,
    ...candidates.slice(0, limit).map((m) => m.id.length),
  );
  for (const item of candidates.slice(0, limit)) {
    console.log(
      process.stdout.isTTY
        ? `${item.id.padEnd(width)}  ${modelRight(item, c)}  ${paint("mute", item.name, {}, c)}`
        : `${item.id}  ${item.name}`,
    );
  }
  if (candidates.length > limit)
    console.log(
      `Showing ${limit}. Use --search or --limit to narrow the list.`,
    );
  return 0;
}

// Read-only catalog browser used by the launcher.
export async function browseModels(env: Environment = process.env) {
  const c = caps();
  const { models } = await step(
    "fetching the catalog",
    "catalog",
    () => fetchCatalog({ env }),
    (r) => `${r.models.length} models`,
  );
  await select({
    title: `Catalog  ${paint("mute", "all models", {}, c)}`,
    items: routingModels(models).map((model) => modelItem(model, c)),
    filterable: true,
    rows: 10,
    legend: modelLegend(c),
    hints: [
      ["↑↓", "move"],
      ["type", "filter"],
      ["esc", "back"],
    ],
  });
}

function withVersion(
  executable: string,
  adapter: Harness,
  c: TerminalCapabilities,
) {
  const found = adapter.version?.(executable);
  return found ? `${executable}  ${paint("mute", found, {}, c)}` : executable;
}

export async function runDoctor(
  { target }: { target?: HarnessId } = {},
  env: Environment = process.env,
) {
  const { key, source } = resolveKey(env);
  const c = caps();
  console.log(ledger(key ? "ok" : "bad", "api key", source, c));
  if (!target) {
    for (const adapter of listHarnesses()) {
      const found = which(adapter.binary, env.PATH);
      console.log(
        found
          ? ledger("ok", adapter.label, withVersion(found, adapter, c), c)
          : `${ledger("bad", adapter.label, "not installed", c)}\n    ${paint("mute", adapter.installHint, {}, c)}`,
      );
    }
    console.log(
      `\n  ${paint("mute", "Run cn doctor <tool> for a live route check.", {}, c)}`,
    );
    return key ? 0 : 1;
  }
  const adapter = getHarness(target);
  const executable = which(adapter.binary, env.PATH);
  if (!executable) {
    console.log(
      `${ledger("bad", adapter.label, "not installed", c)}\n    ${paint("mute", adapter.installHint, {}, c)}`,
    );
    return 1;
  }
  console.log(
    ledger("ok", adapter.label, withVersion(executable, adapter, c), c),
  );
  if (!key) return 1;
  await step("checking the key", "key", () => validateKey(key), "valid");
  const model = readPreferences(env)[target];
  try {
    const { models, source: from } = await fetchCatalog({ env });
    const eligible = modelsFor(target, models);
    console.log(
      ledger(
        eligible.some((m) => m.id === model) ? "ok" : "warn",
        "catalog",
        `${eligible.length} eligible models ${paint("mute", `(${from})`, {}, c)}`,
        c,
      ),
    );
  } catch {
    console.log(ledger("warn", "catalog", "unavailable", c));
  }
  await step(
    `probing ${model}`,
    "route",
    () => probeHarness(target, model, key),
    `OK ${paint("mute", `(${model})`, {}, c)}`,
  );
  return 0;
}
