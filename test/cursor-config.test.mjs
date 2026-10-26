import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
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
} from "../dist/lib/cursor-config.js";
import {
  readDatabaseRows,
  changeDatabaseRows,
} from "../dist/lib/sqlite-store.js";
import {
  configureTool,
  resetTool,
  toolConfigured,
} from "../dist/lib/tool-config.js";
import { writeKey, writeJson } from "../dist/lib/settings.js";
import { tempDir, runCn } from "./helpers.mjs";

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
  assert.equal(out.status, 0, out.stderr);
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
  assert.equal(cursorConfigured(f.env), true);
  const user = userOf(f);
  assert.equal(user.openAIBaseUrl, `${ROOT}/v1`);
  assert.equal(user.useOpenAIKey, true);
  assert.deepEqual(user.aiSettings.userAddedModels, [
    "my-model",
    "test-tool-model",
  ]);
  assert.deepEqual(user.aiSettings.modelOverrideEnabled, [
    "my-model",
    "test-tool-model",
  ]);
  assert.equal(rowsOf(f).get(CURSOR_KEY_ROW), "sk-dummy");
  assert.equal(rowsOf(f).has(CURSOR_SECRET_ROW), false);
  assert.equal(fs.statSync(f.database).mode & 0o777, 0o600);
  configureCursor(ROOT, "sk-dummy", models, f.env);
  assert.equal(resetCursor(f.env).reset, true);
  assert.deepEqual(userOf(f), initial);
  assert.deepEqual(rowsOf(f), before);
  assert.equal(resetCursor(f.env).reset, false);
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
  assert.ok(result.preserved.includes("userAddedModels"));
  assert.ok(result.preserved.some((v) => v.includes("API key")));
  assert.equal(userOf(f).theme, "light");
  assert.ok(userOf(f).aiSettings.userAddedModels.includes("later"));
  assert.equal(rowsOf(f).get(CURSOR_KEY_ROW), "different-key");
  assert.equal(cursorConfigured(f.env), false);
  // Explicit Configure after Reset starts a new baseline using the preserved edits.
  configureCursor(ROOT, "sk-new", models, f.env);
  resetCursor(f.env);
  assert.equal(rowsOf(f).get(CURSOR_KEY_ROW), "different-key");
});

test("Cursor Reset preserves an encrypted credential whose ownership cannot be verified", () => {
  const f = fixture();
  configureCursor(ROOT, "sk-dummy", models, f.env);
  edit(f, CURSOR_KEY_ROW, null);
  edit(f, CURSOR_SECRET_ROW, "new-encrypted-value");
  const result = resetCursor(f.env);
  assert.ok(result.preserved.some((v) => v.includes("encrypted")));
  assert.equal(rowsOf(f).get(CURSOR_SECRET_ROW), "new-encrypted-value");
});

test("Cursor key rotation keeps the first restore baseline and rejects edited keys", () => {
  const f = fixture();
  configureCursor(ROOT, "sk-dummy", models, f.env);
  refreshCursorKey("sk-rotated", f.env);
  assert.equal(rowsOf(f).get(CURSOR_KEY_ROW), "sk-rotated");
  edit(f, CURSOR_KEY_ROW, "user-edit");
  assert.throws(
    () => refreshCursorKey("sk-other", f.env),
    /edited or encrypted/,
  );
  assert.throws(
    () => configureCursor(ROOT, "sk-other", models, f.env),
    /changed since Configure/,
  );
});

test("Cursor settings update is atomic if a read row changed concurrently", () => {
  const f = fixture();
  const stale = rowsOf(f);
  edit(f, "unrelated", "changed");
  assert.throws(
    () =>
      changeDatabaseRows(
        f.database,
        keys,
        stale,
        new Map([[CURSOR_KEY_ROW, "must-not-commit"]]),
        f.env,
      ),
    /No partial/,
  );
  assert.equal(rowsOf(f).has(CURSOR_KEY_ROW), false);
  assert.equal(rowsOf(f).get("unrelated"), "changed");
});

test("Cursor rejects running processes, malformed settings, symlinks and empty catalogs", () => {
  const f = fixture();
  const before = rowsOf(f);
  fs.writeFileSync(path.join(f.bin, "pgrep"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  assert.throws(
    () => configureCursor(ROOT, "sk-dummy", models, f.env),
    /Quit Cursor/,
  );
  assert.deepEqual(rowsOf(f), before);
  fs.writeFileSync(path.join(f.bin, "pgrep"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  assert.throws(
    () => configureCursor(ROOT, "sk-dummy", [], f.env),
    /No tool-calling/,
  );
  edit(f, CURSOR_USER_ROW, '{"aiSettings":{"userAddedModels":42}}');
  assert.throws(
    () => configureCursor(ROOT, "sk-dummy", models, f.env),
    /unsupported/,
  );
  const renamed = f.database + ".original";
  fs.renameSync(f.database, renamed);
  fs.symlinkSync(renamed, f.database);
  assert.throws(
    () => configureCursor(ROOT, "sk-dummy", models, f.env),
    /symbolic link/,
  );
});

test("Cursor CLI Configure/Reset and global Reset/Logout include desktop credentials", async () => {
  for (const operation of ["named", "reset", "logout"]) {
    const f = fixture();
    writeKey("sk-saved", f.env);
    writeJson(path.join(f.env.CN_CONFIG_HOME, "catalog.json"), {
      version: 3,
      fetched_at: Date.now(),
      models,
    });
    await configureTool("cursor", f.env);
    assert.equal(toolConfigured("cursor", f.env), true);
    if (operation === "named") {
      const result = runCn(["reset", "cursor"], { env: f.env });
      assert.equal(result.status, 0, result.stderr);
      const configured = runCn(["configure", "cursor"], { env: f.env });
      assert.equal(configured.status, 0, configured.stderr);
      assert.match(configured.stdout, /Cursor's servers/);
      resetTool("cursor", f.env);
    } else {
      const result = runCn(
        operation === "reset" ? ["reset", "--yes"] : ["logout"],
        { env: f.env },
      );
      assert.equal(result.status, 0, result.stderr);
    }
    assert.deepEqual(userOf(f), initial);
    assert.equal(rowsOf(f).get(CURSOR_SECRET_ROW), "original-encrypted-key");
  }
});

test("Cursor SQL values with quotes round-trip without executing their contents", () => {
  const f = fixture();
  const user = userOf(f);
  user.theme = "I'm a quoted value; DROP TABLE ItemTable; --";
  edit(f, CURSOR_USER_ROW, JSON.stringify(user));
  configureCursor(ROOT, "sk-key'with-quote", models, f.env);
  assert.equal(rowsOf(f).get(CURSOR_KEY_ROW), "sk-key'with-quote");
  resetCursor(f.env);
  assert.equal(userOf(f).theme, user.theme);
  assert.equal(rowsOf(f).get("unrelated"), "keep");
});

test("Cursor rejects malformed restore records without changing credentials", () => {
  const f = fixture();
  configureCursor(ROOT, "sk-dummy", models, f.env);
  edit(f, CURSOR_RECEIPT_ROW, JSON.stringify({ version: 1, active: true }));
  const before = rowsOf(f);
  assert.throws(() => resetCursor(f.env), /restore record is invalid/);
  assert.deepEqual(rowsOf(f), before);
});
