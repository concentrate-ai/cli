import {
  configurableTool,
  listConfigurableTools,
} from "./configurable-tools.js";
import { CURSOR_NOTICE } from "./cursor-config.js";
import type {
  ConfigurableToolId,
  Environment,
  HarnessId,
  MenuItem,
  TerminalCapabilities,
} from "./types.js";
import {
  browseModels,
  runDoctor,
  runSetup,
  runModel,
  runKey,
  showConfig,
} from "./commands.js";
import { launch, which } from "./launch.js";
import { getHarness, listHarnesses } from "./harnesses/registry.js";
import { needsSetup, readPreferences, resolveKey } from "./settings.js";
import { focusIn, header } from "./ui/brand.js";
import { caps, paint } from "./ui/term.js";
import { glyphs } from "./ui/theme.js";
import { select } from "./ui/widgets.js";
import { configureTool, resetTool, toolConfigured } from "./tool-config.js";
import { CnError } from "./errors.js";
import { errorMessage } from "./validation.js";
import { ledger } from "./ui/layout.js";
import { version } from "./version.js";

const MANAGE: MenuItem[] = [
  {
    value: "configure",
    label: "configure",
    note: "Connect a coding tool to Concentrate",
    about:
      "Saves Concentrate connection and model settings so commands like claude use your Concentrate key. Stays enabled until you choose Reset.",
  },
  {
    value: "reset",
    label: "reset",
    note: "Remove Concentrate setup from a coding tool",
    about:
      "Removes the Concentrate setup added by cn from a coding tool. Keeps your other settings, chat history, and saved cn API key.",
  },
  {
    value: "settings",
    label: "settings",
    note: "Default models and API key",
    about:
      "Configure a tool permanently, reset its integration, choose default models, or replace your API key. Provider selection is automatic.",
  },
  {
    value: "models",
    label: "models",
    note: "Browse the live catalog",
    about: "Search every model by name, context window, and capability.",
  },
  {
    value: "doctor",
    label: "doctor",
    note: "Check installs, key, and routes",
    about: "Find which tools are installed and whether your key works.",
  },
];

// A quiet dot when a tool is ready; words only when something needs attention.
function toolStatus(
  installed: boolean,
  hasKey: boolean,
  c: TerminalCapabilities,
) {
  const g = glyphs(c);
  if (!installed) return paint("mute", `${g.off} not installed`, {}, c);
  if (!hasKey) return paint("focus", `${g.half} needs a key`, {}, c);
  return paint("ok", g.ok, {}, c);
}

export function menuItems(env: Environment, c = caps()) {
  const { key, source } = resolveKey(env);
  const preferences = readPreferences(env);
  const tools = listHarnesses().map((adapter) => {
    const installed = Boolean(which(adapter.binary, env.PATH));
    return {
      value: `tool:${adapter.id}`,
      label: adapter.id,
      note: adapter.label,
      meta: preferences[adapter.id],
      right: toolStatus(installed, Boolean(key), c),
      ready: installed && Boolean(key),
      about: !installed
        ? adapter.installHint
        : `Starts ${adapter.label} on ${preferences[adapter.id]}. Change it with cn model ${adapter.id}.`,
    };
  });
  const ready = tools.filter((tool) => tool.ready).length;
  const g = glyphs(c);
  const keyLine = key
    ? `${paint("ok", g.ok, {}, c)} ${paint("mute", source === "stored" ? "key saved" : "key from environment", {}, c)}`
    : `${paint("focus", g.half, {}, c)} ${paint("mute", "no key yet", {}, c)}`;
  return {
    items: [{ group: "launch" }, ...tools, { group: "manage" }, ...MANAGE],
    initial: tools.find((tool) => tool.ready)?.value ?? tools[0].value,
    status: `${keyLine}   ${paint("mute", `${ready} of ${tools.length} tools ready`, {}, c)}`,
  };
}

// Each screen owns its navigation; command-line invocations still exit normally.
async function back(env: Environment) {
  await select(
    {
      items: [
        { value: "back", label: "Back", note: "Return to the previous menu" },
      ],
      hints: [["↵ / esc", "back"]],
    },
    env,
  );
}

async function action(
  work: () => unknown | Promise<unknown>,
  env: Environment,
) {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof CnError) || error.exitCode === 130) throw error;
    console.error(ledger("bad", "attention", errorMessage(error)));
  }
  console.log();
  await back(env);
}

type IntegrationAction = "configure" | "reset";

async function integrateTool(
  operation: IntegrationAction,
  target: ConfigurableToolId,
  env: Environment,
) {
  const tool = configurableTool(target);
  if (operation === "configure") {
    const file = await configureTool(target, env);
    console.log(
      ledger(
        "ok",
        tool.label,
        `Concentrate connected. Open the tool normally after restarting it. Settings file: ${file}`,
      ),
    );
  } else {
    const result = resetTool(target, env);
    console.log(
      ledger(
        result.reset ? "ok" : "mute",
        tool.label,
        result.reset
          ? "Concentrate setup removed. Restart the tool."
          : "No Concentrate setup added by cn to remove.",
      ),
    );
    for (const field of result.preserved)
      console.log(`Kept your edit: ${field}`);
    console.log(
      "A Concentrate connection set separately in your shell can still apply.",
    );
  }
}

async function integrationPicker(
  operation: IntegrationAction,
  env: Environment,
) {
  let initial: string | undefined;
  for (;;) {
    const choice = await select(
      {
        title: operation === "configure" ? "Configure a tool" : "Reset a tool",
        initial,
        items: [
          ...listConfigurableTools().map((tool) => ({
            value: tool.id,
            label: tool.label,
            note: toolConfigured(tool.id, env)
              ? operation === "configure"
                ? "Configured · refresh saved settings"
                : "Remove this tool’s Concentrate setup"
              : operation === "configure"
                ? "Use Concentrate for direct launches"
                : "No Concentrate setup added by cn",
          })),
          { value: "back", label: "Back", note: "Return to home" },
        ],
        detail: (item) =>
          item.value === "back"
            ? ["Return to the home menu."]
            : item.value === "cursor"
              ? [CURSOR_NOTICE]
              : [
                  operation === "configure"
                    ? "Saves Concentrate connection and model settings. The tool’s normal command will use your saved Concentrate key. Restart the tool afterward."
                    : "Removes the Concentrate setup added by cn from this tool. Keeps your other settings, chat history, and saved cn API key. Restart the tool afterward.",
                ],
      },
      env,
    );
    if (choice.cancel || choice.value === "back") return;
    initial = choice.value;
    await action(
      () => integrateTool(operation, choice.value as ConfigurableToolId, env),
      env,
    );
  }
}

async function toolSettings(target: ConfigurableToolId, env: Environment) {
  const tool = configurableTool(target);
  let initial = target === "cursor" ? "configure" : "model";
  for (;;) {
    const configured = toolConfigured(target, env);
    const choice = await select(
      {
        title: `${tool.label} settings`,
        initial,
        items: [
          ...(target === "cursor"
            ? []
            : [
                {
                  value: "model",
                  label: "Default model",
                  note: readPreferences(env)[target],
                },
              ]),
          {
            value: "configure",
            label: "Configure permanently",
            note: configured
              ? "Configured · refresh saved settings"
              : `Save Concentrate in this tool’s config`,
          },
          {
            value: "reset",
            label: "Reset tool integration",
            note: configured
              ? "Remove this tool’s Concentrate setup"
              : "No Concentrate setup added by cn",
          },
          { value: "back", label: "Back", note: "Return to Settings" },
        ],
        detail: (item) => [
          target === "cursor"
            ? CURSOR_NOTICE
            : item.value === "configure"
              ? `Saves Concentrate connection and model settings so this tool’s normal command uses your saved Concentrate key. Restart the tool afterward.`
              : item.value === "reset"
                ? "Removes the Concentrate setup added by cn. Keeps your other settings, chat history, and saved cn API key. Restart the tool afterward."
                : "The default model applies to Concentrate launches. Provider selection is automatic.",
        ],
      },
      env,
    );
    if (choice.cancel || choice.value === "back") return;
    initial = choice.value;
    await action(
      () =>
        choice.value === "model" && target !== "cursor"
          ? runModel({ target }, env)
          : integrateTool(choice.value as IntegrationAction, target, env),
      env,
    );
  }
}

export async function runSettings(env: Environment = process.env) {
  let initial = "";
  for (;;) {
    const preferences = readPreferences(env);
    const choice = await select(
      {
        title: "Settings",
        initial,
        items: [
          { group: "tools" },
          ...listConfigurableTools().map((tool) => ({
            value: tool.id,
            label: tool.label,
            note: `${tool.id === "cursor" ? "Choose models inside Cursor" : preferences[tool.id]}${toolConfigured(tool.id, env) ? " · configured" : ""}`,
            about:
              tool.id === "cursor"
                ? CURSOR_NOTICE
                : `Choose a default model, connect this tool to Concentrate, or remove its Concentrate setup for ${tool.label}.`,
          })),
          { group: "account" },
          { value: "key", label: "API key", note: "Save or replace your key" },
          {
            value: "config",
            label: "Configuration",
            note: "View saved defaults and key source",
          },
          { value: "back", label: "Back", note: "Return to home" },
        ],
        detail: (item) => [
          item.about ?? "Provider selection is automatic for every tool.",
        ],
        rows: 12,
      },
      env,
    );
    if (choice.cancel || choice.value === "back") return 0;
    initial = choice.value;
    if (choice.value !== "key" && choice.value !== "config") {
      await toolSettings(choice.value as ConfigurableToolId, env);
      continue;
    }
    await action(() => {
      if (choice.value === "key") return runKey({}, env);
      return showConfig(env);
    }, env);
  }
}

async function doctor(env: Environment) {
  await runDoctor({}, env);
  let initial = "back";
  for (;;) {
    const choice = await select(
      {
        title: "Doctor",
        initial,
        items: [
          { value: "back", label: "Back", note: "Return to home" },
          {
            value: "recheck",
            label: "Recheck installs",
            note: "Check local tools and key status",
          },
          { group: "live route checks" },
          ...listConfigurableTools().map((tool) => ({
            value: tool.id,
            label: tool.label,
            note: "Check key, catalog, and model route",
          })),
        ],
        detail: (item) => [
          item.value === "back" || item.value === "recheck"
            ? "Local checks do not send a model request."
            : "Sends a small test request using this tool's default model. API usage may be billed.",
        ],
        rows: 10,
      },
      env,
    );
    if (choice.cancel || choice.value === "back") return 0;
    initial = choice.value;
    await action(
      () =>
        runDoctor(
          choice.value === "recheck"
            ? {}
            : {
                target: choice.value as HarnessId,
              },
          env,
        ),
      env,
    );
  }
}

export async function runLauncher(env: Environment = process.env) {
  const c = caps(env);
  await focusIn(c);
  let initial: string | undefined;
  for (;;) {
    const menu = menuItems(env, c);
    console.log(
      header(version(), { status: menu.status }, c).join("\n") + "\n",
    );
    const choice = await select(
      {
        items: menu.items,
        initial: initial ?? menu.initial,
        rows: 14,
        detail: (item) => [item.about ?? ""],
        hints: [
          ["↑↓", "move"],
          ["↵", "open"],
          ["esc / q", "quit"],
        ],
      },
      env,
    );
    if (choice.cancel) return 0;
    initial = choice.value;
    try {
      if (choice.value.startsWith("tool:")) {
        const target = choice.value.slice(5) as HarnessId;
        if (needsSetup(env) && which(getHarness(target).binary, env.PATH))
          await runSetup({ showHeader: false }, env);
        const code = await launch(target, {}, env);
        if (code)
          console.log(ledger("warn", "tool exited", `Exit code ${code}`));
      } else if (choice.value === "configure" || choice.value === "reset")
        await integrationPicker(choice.value, env);
      else if (choice.value === "settings") await runSettings(env);
      else if (choice.value === "models") await browseModels(env);
      else await doctor(env);
    } catch (error) {
      if (!(error instanceof CnError) || error.exitCode === 130) throw error;
      console.error(ledger("bad", "attention", errorMessage(error)));
      await back(env);
    }
  }
}
