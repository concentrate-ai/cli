import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect } from "vitest";
import {
  cursorDatabase,
  configureCursor,
  resetCursor,
  cursorConfigured,
  refreshCursorKey,
  CURSOR_USER_ROW,
  CURSOR_KEY_ROW,
  CURSOR_SECRET_ROW,
  CURSOR_RECEIPT_ROW,
} from "../src/lib/cursor-config.js";
import {
  readDatabaseRows,
  changeDatabaseRows,
} from "../src/lib/sqlite-store.js";
import {
  configureTool,
  resetTool,
  toolConfigured,
} from "../src/lib/tool-config.js";
import { writeKey, writeJson } from "../src/lib/settings.js";
import { tempDir, runCn } from "./helpers.js";

const ROOT = "https://api.concentrate.ai";
const models = [
  { id: "test-tool-model", name: "Tool model", chat_candidate: true },
  { id: "not-a-tool-model", name: "Chat only", chat_candidate: false },
];
const keys = [
  CURSOR_USER_ROW,
  CURSOR_KEY_ROW,
  CURSOR_SECRET_ROW,
  CURSOR_RECEIPT_ROW,
  "unrelated",
];
const initial = {
  theme: "dark",
  useOpenAIKey: false,
  openAIBaseUrl: "https://previous.example/v1",
  aiSettings: {
    userAddedModels: ["my-model"],
    modelOverrideEnabled: ["my-model"],
    modelOverrideDisabled: ["disabled-model"],
    otherSetting: "keep",
  },
};
function fixture() {
  const home = fs.realpathSync(tempDir("cn-cursor-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "pgrep"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  const env = {
    HOME: home,
    PATH: `${bin}:${path.dirname(process.execPath)}`,
    CN_CONFIG_HOME: path.join(home, "cn"),
    CN_OFFLINE: "1",
  };
  const database = cursorDatabase(env);
  fs.mkdirSync(path.dirname(database), { recursive: true });
  const sql =
    "CREATE TABLE ItemTable(key TEXT UNIQUE ON CONFLICT REPLACE, value TEXT);";
  const out = spawnSync("/usr/bin/sqlite3", [database], {
    input: sql,
    encoding: "utf8",
  });
  expect(out.status, out.stderr).toBe(0);
  changeDatabaseRows(
    database,
    keys,
    new Map(),
    new Map([
      [CURSOR_USER_ROW, JSON.stringify(initial)],
      [CURSOR_SECRET_ROW, "original-encrypted-key"],
      ["unrelated", "keep"],
    ]),
    env,
  );
  return { env, database, bin };
}
const rowsOf = ({ database, env }) => readDatabaseRows(database, keys, env);
const userOf = (fixture) => JSON.parse(rowsOf(fixture).get(CURSOR_USER_ROW));
function edit(fixture, key, value) {
  const rows = rowsOf(fixture);
  changeDatabaseRows(
    fixture.database,
    keys,
    rows,
    new Map([[key, value]]),
    fixture.env,
  );
}

test("Cursor Configure populates tool models, preserves user models, and Reset restores settings and key", () => {
  const f = fixture();
  const before = rowsOf(f);
  configureCursor(ROOT, "sk-dummy", models, f.env);
  expect(cursorConfigured(f.env)).toBe(true);
  const user = userOf(f);
  expect(user.openAIBaseUrl).toBe(`${ROOT}/v1`);
  expect(user.useOpenAIKey).toBe(true);
  expect(user.aiSettings.userAddedModels).toStrictEqual([
    "my-model",
    "test-tool-model",
  ]);
  expect(user.aiSettings.modelOverrideEnabled).toStrictEqual([
    "my-model",
    "test-tool-model",
  ]);
  expect(rowsOf(f).get(CURSOR_KEY_ROW)).toBe("sk-dummy");
  expect(rowsOf(f).has(CURSOR_SECRET_ROW)).toBe(false);
  expect(fs.statSync(f.database).mode & 0o777).toBe(0o600);
  configureCursor(ROOT, "sk-dummy", models, f.env);
  expect(resetCursor(f.env).reset).toBe(true);
  expect(userOf(f)).toStrictEqual(initial);
  expect(rowsOf(f)).toStrictEqual(before);
  expect(resetCursor(f.env).reset).toBe(false);
});

test("Cursor Reset keeps later changes to settings, model lists, and credentials", () => {
  const f = fixture();
  configureCursor(ROOT, "sk-dummy", models, f.env);
  const user = userOf(f);
  user.theme = "light";
  user.aiSettings.userAddedModels.push("later");
  edit(f, CURSOR_USER_ROW, JSON.stringify(user));
  edit(f, CURSOR_KEY_ROW, "different-key");
  const result = resetCursor(f.env);
  expect(result.preserved).toContain("userAddedModels");
  expect(result.preserved).toContainEqual(expect.stringContaining("API key"));
  expect(userOf(f).theme).toBe("light");
  expect(userOf(f).aiSettings.userAddedModels).toContain("later");
  expect(rowsOf(f).get(CURSOR_KEY_ROW)).toBe("different-key");
  expect(cursorConfigured(f.env)).toBe(false);
  // Explicit Configure after Reset starts a new baseline using the preserved edits.
  configureCursor(ROOT, "sk-new", models, f.env);
  resetCursor(f.env);
  expect(rowsOf(f).get(CURSOR_KEY_ROW)).toBe("different-key");
});

test("Cursor Reset preserves an encrypted credential whose ownership cannot be verified", () => {
  const f = fixture();
  configureCursor(ROOT, "sk-dummy", models, f.env);
  edit(f, CURSOR_KEY_ROW, null);
  edit(f, CURSOR_SECRET_ROW, "new-encrypted-value");
  const result = resetCursor(f.env);
  expect(result.preserved).toContainEqual(expect.stringContaining("encrypted"));
  expect(rowsOf(f).get(CURSOR_SECRET_ROW)).toBe("new-encrypted-value");
});

test("Cursor key rotation keeps the first restore baseline and rejects edited keys", () => {
  const f = fixture();
  configureCursor(ROOT, "sk-dummy", models, f.env);
  refreshCursorKey("sk-rotated", f.env);
  expect(rowsOf(f).get(CURSOR_KEY_ROW)).toBe("sk-rotated");
  edit(f, CURSOR_KEY_ROW, "user-edit");
  expect(() => refreshCursorKey("sk-other", f.env)).toThrow(
    /edited or encrypted/,
  );
  expect(() => configureCursor(ROOT, "sk-other", models, f.env)).toThrow(
    /changed since Configure/,
  );
});

test("Cursor settings update is atomic if a read row changed concurrently", () => {
  const f = fixture();
  const stale = rowsOf(f);
  edit(f, "unrelated", "changed");
  expect(() =>
    changeDatabaseRows(
      f.database,
      keys,
      stale,
      new Map([[CURSOR_KEY_ROW, "must-not-commit"]]),
      f.env,
    ),
  ).toThrow(/No partial/);
  expect(rowsOf(f).has(CURSOR_KEY_ROW)).toBe(false);
  expect(rowsOf(f).get("unrelated")).toBe("changed");
});

test("Cursor rejects running processes, malformed settings, symlinks and empty catalogs", () => {
  const f = fixture();
  const before = rowsOf(f);
  fs.writeFileSync(path.join(f.bin, "pgrep"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  expect(() => configureCursor(ROOT, "sk-dummy", models, f.env)).toThrow(
    /Quit Cursor/,
  );
  expect(rowsOf(f)).toStrictEqual(before);
  fs.writeFileSync(path.join(f.bin, "pgrep"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  expect(() => configureCursor(ROOT, "sk-dummy", [], f.env)).toThrow(
    /No tool-calling/,
  );
  edit(f, CURSOR_USER_ROW, '{"aiSettings":{"userAddedModels":42}}');
  expect(() => configureCursor(ROOT, "sk-dummy", models, f.env)).toThrow(
    /unsupported/,
  );
  const renamed = f.database + ".original";
  fs.renameSync(f.database, renamed);
  fs.symlinkSync(renamed, f.database);
  expect(() => configureCursor(ROOT, "sk-dummy", models, f.env)).toThrow(
    /symbolic link/,
  );
});

const configuredWithSavedKey = async () => {
  const f = fixture();
  writeKey("sk-saved", f.env);
  writeJson(path.join(f.env.CN_CONFIG_HOME, "catalog.json"), {
    version: 6,
    fetched_at: Date.now(),
    models,
  });
  await configureTool("cursor", f.env);
  expect(toolConfigured("cursor", f.env)).toBe(true);
  return f;
};

test("Cursor CLI Configure/Reset and global Reset/Logout include desktop credentials: named", async () => {
  const f = await configuredWithSavedKey();
  const result = runCn(["reset", "cursor"], { env: f.env });
  expect(result.status, result.stderr).toBe(0);
  const configured = runCn(["configure", "cursor"], { env: f.env });
  expect(configured.status, configured.stderr).toBe(0);
  expect(configured.stdout).toMatch(/Cursor's servers/);
  resetTool("cursor", f.env);
  expect(userOf(f)).toStrictEqual(initial);
  expect(rowsOf(f).get(CURSOR_SECRET_ROW)).toBe("original-encrypted-key");
});

test.each([
  ["reset", ["reset", "--yes"]],
  ["logout", ["logout"]],
])(
  "Cursor CLI Configure/Reset and global Reset/Logout include desktop credentials: %s",
  async (_operation, args) => {
    const f = await configuredWithSavedKey();
    const result = runCn(args, { env: f.env });
    expect(result.status, result.stderr).toBe(0);
    expect(userOf(f)).toStrictEqual(initial);
    expect(rowsOf(f).get(CURSOR_SECRET_ROW)).toBe("original-encrypted-key");
  },
);

test("Cursor SQL values with quotes round-trip without executing their contents", () => {
  const f = fixture();
  const user = userOf(f);
  user.theme = "I'm a quoted value; DROP TABLE ItemTable; --";
  edit(f, CURSOR_USER_ROW, JSON.stringify(user));
  configureCursor(ROOT, "sk-key'with-quote", models, f.env);
  expect(rowsOf(f).get(CURSOR_KEY_ROW)).toBe("sk-key'with-quote");
  resetCursor(f.env);
  expect(userOf(f).theme).toBe(user.theme);
  expect(rowsOf(f).get("unrelated")).toBe("keep");
});

test("Cursor rejects malformed restore records without changing credentials", () => {
  const f = fixture();
  configureCursor(ROOT, "sk-dummy", models, f.env);
  edit(f, CURSOR_RECEIPT_ROW, JSON.stringify({ version: 1, active: true }));
  const before = rowsOf(f);
  expect(() => resetCursor(f.env)).toThrow(/restore record is invalid/);
  expect(rowsOf(f)).toStrictEqual(before);
});

test("Cursor accepts a home folder reached through a symlink but not links inside Cursor's own folders", () => {
  const f = fixture();
  const home = f.env.HOME;
  const alias = path.join(path.dirname(home), `alias-${path.basename(home)}`);
  fs.symlinkSync(home, alias);
  const viaAlias = { ...f.env, HOME: alias };
  expect(() =>
    configureCursor(ROOT, "sk-dummy", models, viaAlias),
  ).not.toThrow();
  expect(cursorConfigured(viaAlias)).toBe(true);
  // A link on the path inside Cursor's data folder is still refused.
  const user = path.dirname(path.dirname(f.database));
  const moved = `${user}.real`;
  fs.renameSync(user, moved);
  fs.symlinkSync(moved, user);
  expect(() => configureCursor(ROOT, "sk-dummy", models, f.env)).toThrow(
    /symbolic link/,
  );
});
