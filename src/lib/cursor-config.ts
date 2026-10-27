import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "node:child_process";
import { CnError } from "./errors.js";
import { configDir } from "./settings.js";
import { withSetupLock } from "./native-config-store.js";
import { which } from "./executables.js";
import { isRecord } from "./validation.js";
import { readDatabaseRows, changeDatabaseRows } from "./sqlite-store.js";
import type { Environment, Model } from "./types.js";

export const CURSOR_NOTICE =
  "Cursor desktop stores your Concentrate API key and sends requests through Cursor's servers before they reach Concentrate. Quit Cursor before Configure or Reset. Select models inside Cursor; Tab completions stay with Cursor.";
export const CURSOR_USER_ROW =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
export const CURSOR_KEY_ROW = "cursorAuth/openAIKey";
export const CURSOR_SECRET_ROW = "secret://cursorAuth/openAIKey";
export const CURSOR_RECEIPT_ROW = "cn.concentrate/setup-v1";
const ROWS = [
  CURSOR_USER_ROW,
  CURSOR_KEY_ROW,
  CURSOR_SECRET_ROW,
  CURSOR_RECEIPT_ROW,
];
const FIELDS = [
  "useOpenAIKey",
  "openAIBaseUrl",
  "userAddedModels",
  "modelOverrideEnabled",
] as const;
type Field = (typeof FIELDS)[number];
type SavedValue = { present: false } | { present: true; value: unknown };
interface Receipt {
  version: 1;
  active: boolean;
  keyDigest: string;
  written: Record<Field, unknown>;
  prior: Record<Field, SavedValue>;
  credentials: Record<string, string | null>;
}
const digest = (key: string) => createHash("sha256").update(key).digest("hex");

export function cursorDatabase(
  env: Environment = process.env,
  platform = process.platform,
) {
  const home = env.HOME || os.homedir();
  const root =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Cursor")
      : platform === "win32"
        ? path.join(
            env.APPDATA || path.join(home, "AppData", "Roaming"),
            "Cursor",
          )
        : path.join(
            env.XDG_CONFIG_HOME || path.join(home, ".config"),
            "Cursor",
          );
  return path.join(root, "User", "globalStorage", "state.vscdb");
}
function requireClosed(env: Environment) {
  if (process.platform === "win32")
    throw new CnError("Cursor setup on Windows is not supported by cn yet.");
  const pgrep = which("pgrep", env.PATH) || which("pgrep", "/usr/bin:/bin");
  if (!pgrep)
    throw new CnError(
      "Cannot check whether Cursor is closed: pgrep is required for Cursor setup.",
    );
  const result = spawnSync(
    pgrep,
    ["-x", process.platform === "darwin" ? "Cursor" : "cursor"],
    { encoding: "utf8", timeout: 5000 },
  );
  if (result.status === 0)
    throw new CnError(
      "Quit Cursor before configuring or resetting it, then retry. Cursor can overwrite settings while it is running.",
    );
  if (result.error || result.status !== 1)
    throw new CnError(
      "Could not confirm that Cursor is closed. Quit Cursor and retry.",
    );
}
function readRows(env: Environment) {
  const file = cursorDatabase(env);
  if (!fs.existsSync(file))
    throw new CnError(
      "No Cursor desktop settings found. Install and open Cursor once, then quit it and retry.",
    );
  return readDatabaseRows(file, ROWS, env);
}
function receipt(rows: Map<string, string>): Receipt | null {
  const text = rows.get(CURSOR_RECEIPT_ROW);
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CnError(
      "Cursor's Concentrate restore record is invalid; nothing was changed.",
    );
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.active !== "boolean" ||
    typeof value.keyDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.keyDigest) ||
    !isRecord(value.written) ||
    !isRecord(value.prior) ||
    value.written.useOpenAIKey !== true ||
    typeof value.written.openAIBaseUrl !== "string" ||
    ![value.written.userAddedModels, value.written.modelOverrideEnabled].every(
      (entries: unknown) =>
        Array.isArray(entries) &&
        entries.every((id: unknown) => typeof id === "string"),
    ) ||
    !isRecord(value.credentials) ||
    !FIELDS.every(
      (field) =>
        isRecord(value.prior) &&
        isRecord(value.prior[field]) &&
        typeof value.prior[field].present === "boolean" &&
        (value.prior[field].present === false ||
          Object.hasOwn(value.prior[field], "value")),
    ) ||
    ![CURSOR_KEY_ROW, CURSOR_SECRET_ROW].every(
      (key) =>
        isRecord(value.credentials) &&
        (value.credentials[key] === null ||
          typeof value.credentials[key] === "string"),
    )
  )
    throw new CnError(
      "Cursor's Concentrate restore record is invalid; nothing was changed.",
    );
  return value as unknown as Receipt;
}
function userSettings(rows: Map<string, string>) {
  let user: unknown;
  try {
    user = JSON.parse(rows.get(CURSOR_USER_ROW) || "null");
  } catch {
    user = null;
  }
  if (!isRecord(user) || !isRecord(user.aiSettings))
    throw new CnError(
      "Cursor's saved settings have an unsupported format; nothing was changed.",
    );
  const ai = user.aiSettings;
  for (const field of [
    "userAddedModels",
    "modelOverrideEnabled",
    "modelOverrideDisabled",
  ])
    if (
      ai[field] !== undefined &&
      (!Array.isArray(ai[field]) ||
        !ai[field].every((id: unknown) => typeof id === "string"))
    )
      throw new CnError(
        "Cursor's model list has an unsupported format; nothing was changed.",
      );
  return { user, ai };
}
const target = (
  field: Field,
  user: Record<string, unknown>,
  ai: Record<string, unknown>,
) => (field === "useOpenAIKey" || field === "openAIBaseUrl" ? user : ai);
const list = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];
function ownsKey(rows: Map<string, string>, old: Receipt) {
  return (
    rows.has(CURSOR_KEY_ROW) &&
    !rows.has(CURSOR_SECRET_ROW) &&
    digest(rows.get(CURSOR_KEY_ROW)!) === old.keyDigest
  );
}
function locked<T>(env: Environment, work: () => T) {
  return withSetupLock(
    path.join(configDir(env), "tool-setups", "cursor"),
    () => {
      requireClosed(env);
      return work();
    },
  );
}
export function cursorConfigured(env: Environment = process.env) {
  if (!fs.existsSync(cursorDatabase(env))) return false;
  // An unreadable database (no sqlite3, a symlinked path) must not block logout,
  // key rotation or global Reset for people who never configured Cursor.
  try {
    return receipt(readRows(env))?.active === true;
  } catch (error) {
    if (error instanceof CnError) return false;
    throw error;
  }
}
export function configureCursor(
  apiRoot: string,
  key: string,
  models: Model[],
  env: Environment = process.env,
) {
  return locked(env, () => {
    const rows = readRows(env);
    const previous = receipt(rows);
    const old = previous?.active ? previous : null;
    const { user, ai } = userSettings(rows);
    if (
      old &&
      (!ownsKey(rows, old) ||
        FIELDS.some(
          (field) =>
            !isDeepStrictEqual(
              target(field, user, ai)[field],
              old.written[field],
            ),
        ))
    )
      throw new CnError(
        "Cursor's Concentrate settings changed since Configure. Run cn reset cursor to preserve those edits before configuring again.",
      );
    const ids = [
      ...new Set(
        models.filter((model) => model.chat_candidate).map((model) => model.id),
      ),
    ];
    if (!ids.length)
      throw new CnError(
        "No tool-calling models are available for Cursor; nothing was changed.",
      );
    const disabled = new Set(list(ai.modelOverrideDisabled));
    const previousModels = new Set(list(ai.userAddedModels));
    const written: Record<Field, unknown> = {
      useOpenAIKey: true,
      openAIBaseUrl: `${apiRoot}/v1`,
      userAddedModels: [...new Set([...previousModels, ...ids])],
      modelOverrideEnabled: [
        ...new Set([
          ...list(ai.modelOverrideEnabled),
          ...ids.filter((id) => !disabled.has(id)),
        ]),
      ],
    };
    const prior =
      old?.prior ||
      (Object.fromEntries(
        FIELDS.map((field) => {
          const doc = target(field, user, ai);
          return [
            field,
            Object.hasOwn(doc, field)
              ? { present: true, value: doc[field] }
              : { present: false },
          ];
        }),
      ) as Record<Field, SavedValue>);
    for (const field of FIELDS) target(field, user, ai)[field] = written[field];
    const saved: Receipt = {
      version: 1,
      active: true,
      keyDigest: digest(key),
      written,
      prior,
      credentials: old?.credentials || {
        [CURSOR_KEY_ROW]: rows.get(CURSOR_KEY_ROW) ?? null,
        [CURSOR_SECRET_ROW]: rows.get(CURSOR_SECRET_ROW) ?? null,
      },
    };
    changeDatabaseRows(
      cursorDatabase(env),
      ROWS,
      rows,
      new Map([
        [CURSOR_USER_ROW, JSON.stringify(user)],
        [CURSOR_KEY_ROW, key],
        [CURSOR_SECRET_ROW, null],
        [CURSOR_RECEIPT_ROW, JSON.stringify(saved)],
      ]),
      env,
    );
    return cursorDatabase(env);
  });
}
export function resetCursor(env: Environment = process.env) {
  if (!fs.existsSync(cursorDatabase(env)))
    return { reset: false, preserved: [] as string[] };
  return locked(env, () => {
    const rows = readRows(env);
    const old = receipt(rows);
    if (!old?.active) return { reset: false, preserved: [] as string[] };
    const { user, ai } = userSettings(rows);
    const preserved: string[] = [];
    const routed = user.openAIBaseUrl === old.written.openAIBaseUrl;
    for (const field of FIELDS) {
      const doc = target(field, user, ai);
      if (isDeepStrictEqual(doc[field], old.written[field])) {
        const prior = old.prior[field];
        if (prior.present) doc[field] = prior.value;
        else delete doc[field];
      } else if (Object.hasOwn(doc, field)) preserved.push(field);
    }
    const changes = new Map<string, string | null>([
      [CURSOR_USER_ROW, JSON.stringify(user)],
    ]);
    if (routed && ownsKey(rows, old)) {
      for (const key of [CURSOR_KEY_ROW, CURSOR_SECRET_ROW])
        changes.set(key, old.credentials[key]);
    } else
      preserved.push(
        "Cursor API key (changed or encrypted; review it in Cursor settings)",
      );
    changes.set(
      CURSOR_RECEIPT_ROW,
      preserved.length ? JSON.stringify({ ...old, active: false }) : null,
    );
    changeDatabaseRows(cursorDatabase(env), ROWS, rows, changes, env);
    return { reset: true, preserved };
  });
}
export function refreshCursorKey(key: string, env: Environment) {
  return locked(env, () => {
    const rows = readRows(env);
    const old = receipt(rows);
    if (!old?.active) return;
    const { user } = userSettings(rows);
    if (!ownsKey(rows, old) || user.openAIBaseUrl !== old.written.openAIBaseUrl)
      throw new CnError(
        "Your cn key was saved, but Cursor's key was edited or encrypted. Review it in Cursor settings and run Configure again.",
      );
    changeDatabaseRows(
      cursorDatabase(env),
      ROWS,
      rows,
      new Map([
        [CURSOR_KEY_ROW, key],
        [
          CURSOR_RECEIPT_ROW,
          JSON.stringify({ ...old, keyDigest: digest(key) }),
        ],
      ]),
      env,
    );
  });
}
