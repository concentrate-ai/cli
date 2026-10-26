import { isConfigurableTool } from "./configurable-tools.js";
import { CURSOR_NOTICE } from "./cursor-config.js";
import type { Environment, HarnessId } from "./types.js";
import {
  runDoctor,
  runKey,
  runLogout,
  runModel,
  runReset,
  runSetup,
  showConfig,
  showModels,
} from "./commands.js";
import { configureTool, resetTool } from "./tool-config.js";
import { errorMessage } from "./validation.js";
import { CnError, EXIT } from "./errors.js";
import { isModelId } from "./safe.js";
import { getHarness, isHarness, listHarnesses } from "./harnesses/registry.js";
import { launch, which } from "./launch.js";
import { runLauncher, runSettings } from "./launcher.js";
import { closePrompts } from "./prompt.js";
import { needsSetup, readStoredKey } from "./settings.js";
import { ledger } from "./ui/layout.js";
import { interactive } from "./ui/widgets.js";
import { version } from "./version.js";

const HELP = `cn - Concentrate AI: one key for every coding agent

Usage:
  cn <tool> [--model <id>] [-- <tool args>]   Launch a tool through Concentrate AI
      tools: ${listHarnesses()
        .map((h) => h.id)
        .join(", ")}
  cn setup [--no-verify] [--models]           Save your API key (--models also picks defaults)
  cn configure <tool>                       Connect a coding tool to Concentrate
  cn reset <tool>                           Remove Concentrate setup from a coding tool
  cn configure cursor                      Connect Cursor desktop (quit Cursor first)
  cn settings                              Open interactive settings
  cn config                                   Show key status and default models
  cn key [--no-verify]                        Replace the saved API key
  cn logout                                   Remove the saved API key
  cn reset [--yes] [--sessions]               Clear everything cn saved and start fresh
  cn model [<tool> [<model-id>]]              Show or change default models
  cn models [<tool>] [--search <text>] [--refresh] [--limit <n>]
  cn doctor [<tool>]                          Check installs, key, and API route
  cn --version
`;

function usageError(message: string) {
  return new CnError(`${message}\nRun cn --help for usage.`, EXIT.USAGE);
}

export function parseLaunchArgs(rest: string[]) {
  let model: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--") return { model, forwarded: rest.slice(i + 1) };
    if (arg === "--model" || arg.startsWith("--model=")) {
      model = arg === "--model" ? rest[(i += 1)] : arg.slice("--model=".length);
      if (!model) throw usageError("--model needs a model ID");
      if (!isModelId(model))
        throw usageError(
          `Not a valid model ID: ${JSON.stringify(model).slice(0, 80)}`,
        );
    } else {
      return { model, forwarded: rest.slice(i) };
    }
  }
  return { model, forwarded: [] };
}

export function parseFlags(
  rest: string[],
  {
    booleans = [],
    values = [],
  }: { booleans?: string[]; values?: string[] } = {},
) {
  const flags: Record<string, string | boolean | undefined> = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (booleans.includes(name)) {
      flags[name] = true;
    } else if (values.includes(name)) {
      if (i + 1 >= rest.length) throw usageError(`--${name} needs a value`);
      flags[name] = rest[(i += 1)];
    } else {
      throw usageError(`Unknown option: ${arg}`);
    }
  }
  return { flags, positionals };
}

function toolArg(value: string | undefined): HarnessId | undefined {
  if (value !== undefined && !isHarness(value)) {
    throw usageError(
      `Unknown tool: ${value}. Choose one of: ${listHarnesses()
        .map((h) => h.id)
        .join(", ")}`,
    );
  }
  return value as HarnessId | undefined;
}

async function dispatch(argv: string[], env: Environment) {
  const [command, ...rest] = argv;
  if (command === "--credential-helper") {
    if (rest.length !== 1)
      throw usageError("Invalid credential helper invocation");
    const key = readStoredKey({ ...env, CN_CONFIG_HOME: rest[0] });
    if (!key) throw new CnError("No saved Concentrate key. Run cn key.");
    process.stdout.write(key + "\n");
    return 0;
  }
  if (!command && interactive(env)) return runLauncher(env);
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(version());
    return 0;
  }
  if (isHarness(command)) {
    const adapter = getHarness(command);
    // A missing tool is reported by launch() without making anyone set up first.
    if (
      interactive(env) &&
      needsSetup(env) &&
      which(adapter.binary, env.PATH)
    ) {
      console.log(
        ledger("warn", "setup", "no API key yet, let's set one up\n"),
      );
      await runSetup({}, env);
      console.log();
    }
    return launch(command, parseLaunchArgs(rest), env);
  }

  switch (command) {
    case "configure": {
      const { positionals } = parseFlags(rest);
      const target = positionals[0];
      if (!target || !isConfigurableTool(target) || positionals.length !== 1)
        throw usageError("Choose one tool: cn configure <tool>");
      if (target === "cursor") console.log(CURSOR_NOTICE);
      const file = await configureTool(target, env);
      console.log(
        `Configured ${target}. Restart the tool to use Concentrate. Configuration: ${file}`,
      );
      return 0;
    }
    case "setup": {
      const { flags } = parseFlags(rest, { booleans: ["no-verify", "models"] });
      return runSetup(
        { verify: !flags["no-verify"], models: Boolean(flags.models) },
        env,
      );
    }
    case "key":
      return runKey(
        {
          verify: !parseFlags(rest, { booleans: ["no-verify"] }).flags[
            "no-verify"
          ],
        },
        env,
      );
    case "settings":
      return interactive(env) ? runSettings(env) : showConfig(env);
    case "config":
      return showConfig(env);
    case "reset": {
      const { flags, positionals } = parseFlags(rest, {
        booleans: ["yes", "sessions"],
      });
      if (positionals.length) {
        const target = positionals[0];
        if (
          !target ||
          !isConfigurableTool(target) ||
          positionals.length !== 1 ||
          flags.sessions
        )
          throw usageError(
            "Use cn reset <tool> to remove its Concentrate setup.",
          );
        const result = resetTool(target, env);
        console.log(
          result.reset
            ? `Concentrate setup removed from ${target}. Restart the tool. Connections set separately in your shell still apply.`
            : `${target} has no Concentrate setup added by cn to remove.`,
        );
        for (const field of result.preserved)
          console.log(`Kept your edit: ${field}`);
        return 0;
      }
      return runReset(
        { yes: Boolean(flags.yes), sessions: Boolean(flags.sessions) },
        env,
      );
    }
    case "logout":
      return runLogout(env);
    case "model": {
      const { positionals } = parseFlags(rest);
      return runModel(
        { target: toolArg(positionals[0]), modelId: positionals[1] },
        env,
      );
    }
    case "models": {
      const { flags, positionals } = parseFlags(rest, {
        booleans: ["refresh"],
        values: ["search", "limit"],
      });
      const limit = flags.limit === undefined ? 30 : Number(flags.limit);
      if (!Number.isInteger(limit) || limit < 1)
        throw usageError("--limit must be a positive number");
      return showModels(
        {
          target: toolArg(positionals[0]),
          search: typeof flags.search === "string" ? flags.search : undefined,
          refresh: Boolean(flags.refresh),
          limit,
        },
        env,
      );
    }
    case "doctor":
      return runDoctor(
        { target: toolArg(parseFlags(rest).positionals[0]) },
        env,
      );
    default:
      throw usageError(`Unknown command: ${command}`);
  }
}

export async function main(
  argv = process.argv.slice(2),
  env: Environment = process.env,
) {
  try {
    return await dispatch(argv, env);
  } catch (error) {
    if (error instanceof CnError) {
      console.error(errorMessage(error));
      return error.exitCode;
    }
    console.error(`cn: unexpected error: ${errorMessage(error)}`);
    if (env.CN_DEBUG && error instanceof Error) console.error(error.stack);
    return EXIT.FAILURE;
  } finally {
    closePrompts();
  }
}
