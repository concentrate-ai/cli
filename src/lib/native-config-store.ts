import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CnError } from "./errors.js";
import { parseConfig, setConfig, type ConfigFormat } from "./config-formats.js";
import { readJson, writeJson } from "./settings.js";
import { isRecord } from "./validation.js";

export interface ConfigChange {
  retainOnEditedFile?: boolean;
  key: string[];
  value: unknown;
}
export interface ConfigPlan {
  file: string;
  format: ConfigFormat;
  changes: ConfigChange[];
  mode?: number;
}
interface Snapshot extends ConfigPlan {
  original: string | null;
  written: string;
}
interface Receipt {
  version: 1;
  active: boolean;
  files: Snapshot[];
}

export function readConfigFile(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new CnError(`Refusing to change a non-regular file: ${file}`);
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function ensureDirectory(directory: string) {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new CnError(
        `Refusing to write through a non-directory or symbolic link: ${directory}`,
      );
    return;
  }
  const parent = path.dirname(directory);
  if (parent !== directory) ensureDirectory(parent);
  fs.mkdirSync(directory, { mode: 0o700 });
}

function replaceFile(file: string, text: string | null, mode = 0o600) {
  readConfigFile(file);
  if (text === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  ensureDirectory(path.dirname(file));
  const temporary = `${file}.cn-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, text, { flag: "wx", mode });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function get(doc: Record<string, unknown>, key: string[]): unknown {
  let value: unknown = doc;
  for (const part of key)
    value =
      isRecord(value) && Object.hasOwn(value, part) ? value[part] : undefined;
  return value;
}

function receipt(file: string, allowed: string[]): Receipt | null {
  const doc = readJson(file);
  if (!Object.keys(doc).length) return null;
  if (
    doc.version !== 1 ||
    typeof doc.active !== "boolean" ||
    !Array.isArray(doc.files)
  )
    throw new CnError(
      "The saved tool restore record is invalid. No tool settings were changed.",
    );
  const files: Snapshot[] = [];
  for (const item of doc.files) {
    if (
      !isRecord(item) ||
      typeof item.file !== "string" ||
      !(
        allowed.includes(item.file) ||
        (path.resolve(item.file) === item.file &&
          item.file.startsWith(path.dirname(file) + path.sep) &&
          !["restore.json", ".lock"].includes(
            path.relative(path.dirname(file), item.file).split(path.sep)[0],
          ))
      ) ||
      !["json", "toml", "text"].includes(String(item.format)) ||
      !(item.original === null || typeof item.original === "string") ||
      typeof item.written !== "string" ||
      !Array.isArray(item.changes)
    )
      throw new CnError(
        "The saved tool restore record does not match this tool's configuration paths. Use the same tool config directories as setup.",
      );
    const changes: ConfigChange[] = [];
    for (const change of item.changes) {
      if (
        !isRecord(change) ||
        !Array.isArray(change.key) ||
        !change.key.length ||
        !change.key.every(
          (part) =>
            typeof part === "string" &&
            !["__proto__", "constructor", "prototype"].includes(part),
        )
      )
        throw new CnError("Invalid saved tool setting path.");
      changes.push({
        key: change.key as string[],
        value: change.value,
        ...(change.retainOnEditedFile === true
          ? { retainOnEditedFile: true }
          : {}),
      });
    }
    files.push({
      file: item.file,
      format: item.format as ConfigFormat,
      original: item.original,
      written: item.written,
      changes,
      mode: item.mode === 0o700 ? 0o700 : 0o600,
    });
  }
  return { version: 1, active: doc.active, files };
}

export function hasNativeSetup(state: string) {
  const data = readJson(state);
  return data.version === 1 && data.active === true;
}

export function withSetupLock<T>(directory: string, work: () => T): T {
  ensureDirectory(directory);
  const lock = path.join(directory, ".lock");
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch {
    throw new CnError(
      `Another tool configuration is in progress. If it was interrupted, remove ${lock} and retry.`,
    );
  }
  try {
    return work();
  } finally {
    fs.rmdirSync(lock);
  }
}

export function applyNativeSetup(state: string, plans: ConfigPlan[]) {
  const old = receipt(
    state,
    plans.map((plan) => plan.file),
  );
  const snapshots: Snapshot[] = [];
  for (const plan of plans) {
    const current = readConfigFile(plan.file);
    const previous = old?.active
      ? old.files.find((file) => file.file === plan.file)
      : undefined;
    const currentDoc = parseConfig(current ?? "", plan.format);
    if (previous) {
      const writtenDoc = parseConfig(previous.written, plan.format);
      if (
        previous.changes.some(
          (change) =>
            !isDeepStrictEqual(
              get(currentDoc, change.key),
              get(writtenDoc, change.key),
            ),
        )
      )
        throw new CnError(
          `${plan.file} was edited after Configure. Reset this tool before configuring it again; your edits will be preserved.`,
        );
    }
    let written = current ?? "";
    for (const change of plan.changes) {
      // Refuse scalar parents instead of silently replacing unrelated settings.
      for (let i = 1; i < change.key.length; i++) {
        const parent = get(currentDoc, change.key.slice(0, i));
        if (parent !== undefined && !isRecord(parent))
          throw new CnError(
            `Cannot configure ${change.key.join(".")} in ${plan.file}: its parent is not an object.`,
          );
      }
      written = setConfig(written, plan.format, change.key, change.value);
    }
    parseConfig(written, plan.format);
    snapshots.push({
      ...plan,
      original: previous ? previous.original : current,
      written,
    });
  }
  const before = snapshots.map((file) => ({
    file: file.file,
    text: readConfigFile(file.file),
  }));
  const previousState = readConfigFile(state);
  // Save the restore record before changing a native configuration.
  writeJson(state, { version: 1, active: true, files: snapshots });
  const applied: Snapshot[] = [];
  try {
    for (const file of snapshots) {
      if (
        readConfigFile(file.file) !==
        before.find((entry) => entry.file === file.file)?.text
      )
        throw new CnError(
          `Configuration changed during setup: ${file.file}. Retry after closing the tool.`,
        );
      replaceFile(file.file, file.written, file.mode);
      applied.push(file);
    }
  } catch (error) {
    let fullyRestored = true;
    for (const file of applied.reverse()) {
      if (readConfigFile(file.file) !== file.written) {
        fullyRestored = false;
        continue;
      }
      replaceFile(
        file.file,
        before.find((entry) => entry.file === file.file)?.text ?? null,
      );
    }
    if (fullyRestored) replaceFile(state, previousState);
    throw error;
  }
}

export function resetNativeSetup(state: string, allowed: string[]) {
  const saved = receipt(state, allowed);
  if (!saved?.active) return { reset: false, preserved: [] as string[] };
  const preserved: string[] = [];
  const updates: { file: string; text: string | null; mode?: number }[] = [];
  // Plan every change before writing. A malformed file leaves the entire setup intact.
  for (const file of saved.files.filter((entry) => entry.format !== "text")) {
    const current = readConfigFile(file.file);
    if (current === null) continue; // A user deletion is also an edit.
    if (current === file.written) {
      updates.push({ file: file.file, text: file.original });
      continue;
    }
    let text = current;
    const currentDoc = parseConfig(current, file.format);
    const writtenDoc = parseConfig(file.written, file.format);
    const originalDoc = parseConfig(file.original ?? "", file.format);
    for (const change of file.changes) {
      if (change.retainOnEditedFile) continue;
      if (
        !isDeepStrictEqual(
          get(currentDoc, change.key),
          get(writtenDoc, change.key),
        )
      ) {
        preserved.push(`${file.file}: ${change.key.join(".")}`);
        continue;
      }
      text = setConfig(
        text,
        file.format,
        change.key,
        get(originalDoc, change.key),
      );
      for (let i = change.key.length - 1; i > 0; i--) {
        const parent = change.key.slice(0, i);
        const value = get(parseConfig(text, file.format), parent);
        if (
          get(originalDoc, parent) === undefined &&
          isRecord(value) &&
          !Object.keys(value).length
        )
          text = setConfig(text, file.format, parent, undefined);
      }
    }
    updates.push({ file: file.file, text });
  }
  for (const file of saved.files.filter((entry) => entry.format === "text")) {
    const current = readConfigFile(file.file);
    if (current === null) continue;
    if (preserved.length || current !== file.written) preserved.push(file.file);
    else
      updates.push({ file: file.file, text: file.original, mode: file.mode });
  }
  const before = new Map(
    updates.map((update) => [update.file, readConfigFile(update.file)]),
  );
  const stateBefore = readConfigFile(state);
  const applied: typeof updates = [];
  try {
    for (const update of updates) {
      if (readConfigFile(update.file) !== before.get(update.file))
        throw new CnError(
          `Configuration changed during Reset: ${update.file}. Close the tool and retry.`,
        );
      replaceFile(update.file, update.text, update.mode);
      applied.push(update);
    }
    if (preserved.length) writeJson(state, { ...saved, active: false });
    else fs.rmSync(state, { force: true });
  } catch (error) {
    for (const update of applied.reverse()) {
      if (readConfigFile(update.file) === update.text)
        replaceFile(update.file, before.get(update.file) ?? null, update.mode);
    }
    replaceFile(state, stateBefore);
    throw error;
  }
  return { reset: true, preserved };
}

// Native OpenCode supports a credential file rather than a command-backed resolver.
// Rotate only the credential cn still owns, keeping the first restore snapshot.
export function refreshNativeCredential(
  state: string,
  allowed: string[],
  file: string,
  value: unknown,
) {
  const saved = receipt(state, allowed);
  if (!saved?.active) return false;
  const snapshot = saved.files.find((entry) => entry.file === file);
  if (!snapshot) return false;
  const current = readConfigFile(file);
  if (current === null) return false;
  if (
    snapshot.format !== "text" ||
    current !== snapshot.written ||
    typeof value !== "string"
  )
    return false;
  const next = value;
  snapshot.written = next;
  snapshot.changes = [{ key: ["content"], value }];
  replaceFile(file, next);
  try {
    writeJson(state, saved);
  } catch (error) {
    replaceFile(file, current);
    throw error;
  }
  return true;
}
