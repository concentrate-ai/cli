import type { Environment, HarnessId, Preferences } from "./types.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isRecord, errorCode, errorMessage } from "./validation.js";
import { CnError } from "./errors.js";
import { isApiKey, isModelId, isOpenAiModel } from "./safe.js";

export const DEFAULT_MODELS = Object.freeze<Preferences>({
  claude: "claude-sonnet-4-6",
  codex: "gpt-6.1-terra",
  opencode: "deepseek-v4-1-flash",
  pi: "deepseek-v4-1-flash",
});

export const HARNESS_IDS = Object.freeze(
  Object.keys(DEFAULT_MODELS) as HarnessId[],
);

function expandHome(value: string) {
  if (value === "~" || value.startsWith("~/"))
    return path.join(os.homedir(), value.slice(1));
  return path.resolve(value);
}

export function configDir(env: Environment = process.env) {
  if (env.CN_CONFIG_HOME) return expandHome(env.CN_CONFIG_HOME);
  if (env.XDG_CONFIG_HOME)
    return path.join(expandHome(env.XDG_CONFIG_HOME), "concentrate-cli");
  return path.join(os.homedir(), ".config", "concentrate-cli");
}

// Credentials and restore receipts hold secrets and must be private. Preferences
// and the model catalog hold none, so a loose mode must not stop cn from starting.
export function readJson(
  file: string,
  { private: requirePrivate = true }: { private?: boolean } = {},
): Record<string, unknown> {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw error;
  }
  if (stat.isSymbolicLink())
    throw new CnError(`Refusing to read a symbolic link: ${file}`);
  if (requirePrivate && stat.mode & 0o077) {
    throw new CnError(
      `Private file is accessible to others: ${file} (run chmod 600)`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new CnError(`Could not read ${file}: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) {
    throw new CnError(`Expected a JSON object in ${file}`);
  }
  return value;
}

export function writeJson(file: string, value: unknown) {
  const dir = path.dirname(file);
  // Only tighten a directory cn created; CN_CONFIG_HOME may point at one the user owns.
  const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) {
    throw new CnError(`Refusing to use a symbolic link: ${dir}`);
  }
  if (created) fs.chmodSync(dir, 0o700);
  const temporary = path.join(
    dir,
    `.cn-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function readPreferences(env: Environment = process.env) {
  const data = readJson(path.join(configDir(env), "config.json"), {
    private: false,
  });
  const configured = data.models ?? {};
  if (!isRecord(configured)) {
    throw new CnError("models must be an object in config.json");
  }
  const models = { ...DEFAULT_MODELS };
  for (const id of HARNESS_IDS) {
    const value =
      typeof configured[id] === "string" ? configured[id].trim() : "";
    // Codex is limited to OpenAI models; anything else falls back to the default.
    if (isModelId(value) && (id !== "codex" || isOpenAiModel(value)))
      models[id] = value;
  }
  return models;
}

// First run: nothing to launch with until there is a key.
export function needsSetup(env: Environment = process.env) {
  return !resolveKeyOrNull(env).key;
}

export function writePreferences(
  models: Preferences,
  env: Environment = process.env,
) {
  const keys = Object.keys(models).sort().join(",");
  if (keys !== [...HARNESS_IDS].sort().join(",")) {
    throw new CnError("Model settings must cover every supported tool");
  }
  for (const value of Object.values(models)) {
    if (!isModelId(value)) {
      throw new CnError(
        `Not a valid model ID: ${JSON.stringify(String(value)).slice(0, 80)}. Use letters, digits, and . _ : / @ + -`,
      );
    }
  }
  const file = path.join(configDir(env), "config.json");
  const { autoProvider: _retired, ...saved } = readJson(file, {
    private: false,
  });
  writeJson(file, { ...saved, models });
}

// For the paths that replace a key: a damaged saved key is treated as absent so
// that cn key and cn setup can always write a good one.
export function readStoredKeyOrNull(env: Environment = process.env) {
  try {
    return readStoredKey(env);
  } catch (error) {
    if (error instanceof CnError) return null;
    throw error;
  }
}

export function readStoredKey(env: Environment = process.env) {
  const file = path.join(configDir(env), "credentials.json");
  const value = readJson(file).api_key;
  if (typeof value !== "string" || !value.trim()) return null;
  if (!isApiKey(value.trim()))
    throw new CnError(
      `The saved key in ${file} is not valid. Run cn key to replace it.`,
    );
  return value.trim();
}

// The environment key, trimmed. A malformed one is an error, never silently used or echoed.
export function environmentKey(env: Environment = process.env) {
  const value = (env.CONCENTRATE_API_KEY ?? "").trim();
  if (!value) return null;
  if (!isApiKey(value))
    throw new CnError(
      "CONCENTRATE_API_KEY contains spaces or control characters. Fix it in your shell profile.",
    );
  return value;
}

export function resolveKey(env: Environment = process.env) {
  const stored = readStoredKey(env);
  if (stored) return { key: stored, source: "stored" };
  const fromEnv = environmentKey(env);
  if (fromEnv) return { key: fromEnv, source: "environment" };
  return { key: null, source: "missing" };
}

// Menus and first-run checks must still open when the saved key is damaged, so
// the user can replace it from inside cn.
export function resolveKeyOrNull(env: Environment = process.env) {
  try {
    return resolveKey(env);
  } catch (error) {
    if (error instanceof CnError) return { key: null, source: "invalid" };
    throw error;
  }
}

export function writeKey(value: unknown, env: Environment = process.env) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key) throw new CnError("API key cannot be empty");
  if (!isApiKey(key))
    throw new CnError(
      "That doesn't look like an API key: it has spaces or control characters.",
    );
  writeJson(path.join(configDir(env), "credentials.json"), { api_key: key });
}

export function deleteStoredKey(env: Environment = process.env) {
  const file = path.join(configDir(env), "credentials.json");
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (stat.isSymbolicLink())
    throw new CnError(`Refusing to remove a symbolic link: ${file}`);
  fs.unlinkSync(file);
  return true;
}

const STATE_FILES = [
  "credentials.json",
  "config.json",
  "catalog.json",
  "codex-provider-declined",
];

// What `cn reset` would remove. Pi chat history only counts when asked for.
export function resetTargets(
  env: Environment = process.env,
  { sessions = false } = {},
) {
  const dir = configDir(env);
  const names = [...STATE_FILES, ...(sessions ? ["pi-sessions"] : [])];
  return names
    .map((name) => path.join(dir, name))
    .filter((target) => {
      try {
        fs.lstatSync(target);
        return true;
      } catch {
        return false;
      }
    });
}

export function resetState(
  env: Environment = process.env,
  options: { sessions?: boolean } = {},
) {
  const removed = resetTargets(env, options);
  for (const target of removed) {
    if (fs.lstatSync(target).isSymbolicLink())
      throw new CnError(`Refusing to remove a symbolic link: ${target}`);
    fs.rmSync(target, { recursive: true, force: true });
  }
  try {
    fs.rmdirSync(configDir(env));
  } catch {
    // not empty (kept sessions) or already gone
  }
  return removed;
}
