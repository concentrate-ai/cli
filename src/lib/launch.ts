import type {
  Environment,
  Harness,
  HarnessId,
  LaunchOptions,
  Model,
  PreparedHarness,
} from "./types.js";
import { errorCode } from "./validation.js";
import os from "node:os";
import { spawn } from "node:child_process";

import {
  ensureModel,
  fetchCatalog,
  modelsFor,
  routingModelId,
} from "./catalog.js";
import { CnError, EXIT } from "./errors.js";
import { getHarness } from "./harnesses/registry.js";
import { readPreferences, resolveKey, writePreferences } from "./settings.js";
import { ledger } from "./ui/layout.js";
import { hasOption, resolveSessionArgs } from "./sessions.js";

export { which } from "./executables.js";
import { which } from "./executables.js";

function missingToolError(adapter: Harness) {
  return new CnError(
    `${adapter.label} isn't installed (\`${adapter.binary}\` was not found on your PATH).\n${adapter.installHint}`,
    EXIT.NOT_FOUND,
  );
}

function run(
  executable: string,
  args: string[],
  env: Environment,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", env });
    // Ctrl-C reaches the whole foreground group; the tool decides how to handle it.
    const onInterrupt = () => {};
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const handlers = { SIGTERM: forward("SIGTERM"), SIGHUP: forward("SIGHUP") };
    process.on("SIGINT", onInterrupt);
    for (const [signal, handler] of Object.entries(handlers))
      process.on(signal, handler);
    const detach = () => {
      process.off("SIGINT", onInterrupt);
      for (const [signal, handler] of Object.entries(handlers))
        process.off(signal, handler);
    };
    child.on("error", (error) => {
      detach();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      detach();
      resolve(code ?? 128 + (os.constants.signals[signal ?? "SIGTERM"] ?? 0));
    });
  });
}

// A model given to the tool directly is a one-off choice, not a new default.
function isResume(harnessId: HarnessId, args: string[]) {
  if (harnessId === "codex")
    return args[0] === "resume" || (args[0] === "exec" && args[1] === "resume");
  return hasOption(
    args,
    "--resume",
    "-r",
    "--continue",
    "-c",
    "--session",
    "-s",
    "--cn-resume",
  );
}

function passesModelFlag(forwarded: string[], flags: readonly string[] = []) {
  return forwarded.some((arg) =>
    flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );
}

// If the user switched models inside the tool, start there next time. Only a
// model that differs from the launch model and exists in the catalog counts.
function rememberModel({
  prepared,
  adapter,
  launched,
  available,
  env,
}: {
  prepared: PreparedHarness;
  adapter: Harness;
  launched: string;
  available: Model[];
  env: Environment;
}) {
  const used = prepared.recall?.();
  if (typeof used !== "string") return;
  const known = new Set(available.map((m) => m.id));
  const id = [used, used.split("/").pop()].find(
    (candidate) => candidate !== undefined && known.has(candidate),
  );
  if (!id || id === launched) return;
  const preferences = readPreferences(env);
  preferences[adapter.id] = id;
  writePreferences(preferences, env);
  // stderr, so a tool's output piped to a file stays clean.
  console.error(
    ledger(
      "ok",
      "remembered",
      `${adapter.label} will start on ${id} next time`,
    ),
  );
}

export async function launch(
  harnessId: HarnessId,
  {
    model: override,
    forwarded = [],
    tty = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  }: LaunchOptions = {},
  env: Environment = process.env,
) {
  const adapter = getHarness(harnessId);

  // Cheapest checks first: a missing tool should never cost a network call.
  const executable = which(adapter.binary, env.PATH);
  if (!executable) throw missingToolError(adapter);

  const { key } = resolveKey(env);
  if (!key) throw new CnError("No API key found. Run cn setup first.");
  const sessionArgs = await resolveSessionArgs(
    harnessId,
    executable,
    forwarded,
    env,
  );
  if (sessionArgs === null) return 0;
  forwarded = sessionArgs;

  let model = override || readPreferences(env)[harnessId];
  let available: Model[];
  let catalogLoaded = false;
  try {
    const { models } = await fetchCatalog({ env });
    model = routingModelId(models, model);
    available = ensureModel(modelsFor(harnessId, models), model);
    catalogLoaded = true;
  } catch {
    console.error(
      "Model catalog unavailable; starting with the selected model only.",
    );
    available = ensureModel([], model);
  }

  if (tty && isResume(harnessId, forwarded))
    console.error(
      ledger(
        "ok",
        "resume",
        `Continuing on ${model} through Concentrate. Requests are billed at API rates.`,
      ),
    );

  const prepared = await adapter.prepare({
    executable,
    model,
    key,
    available,
    forwarded,
    env,
  });
  const childEnv = { ...env, ...prepared.env };
  for (const name of prepared.unset ?? []) delete childEnv[name];

  let code;
  try {
    code = await run(executable, prepared.args, childEnv);
  } catch (error) {
    prepared.cleanup();
    if (errorCode(error) === "ENOENT") throw missingToolError(adapter);
    // Only the error code: spawn messages can quote environment values, including the key.
    throw new CnError(
      `Could not start ${adapter.label} (${errorCode(error) ?? "unknown error"}).`,
    );
  }

  // Remembering is best effort and must never change the tool's exit code. Model
  // switches only happen in interactive sessions, so scripted runs are left alone.
  try {
    if (
      catalogLoaded &&
      tty &&
      !passesModelFlag(forwarded, adapter.modelFlags)
    ) {
      rememberModel({ prepared, adapter, launched: model, available, env });
    }
  } catch (error) {
    console.error(
      ledger(
        "warn",
        "remember",
        `skipped: ${error instanceof CnError ? error.message : "could not read the session"}`,
      ),
    );
  } finally {
    prepared.cleanup();
  }
  if (tty && prepared.resumeHint)
    console.error(`Resume through Concentrate: ${prepared.resumeHint}`);
  return code;
}
