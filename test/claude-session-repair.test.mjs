import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  clearForeignRequestIds,
  repairClaudeSessions,
} from "../dist/lib/claude-session-repair.js";
import { tempDir } from "./helpers.mjs";

const id = "410110a1-cb69-4cb7-b56e-c570abba102b";
const rows = [
  { type: "user", message: { content: "keep conversation" } },
  {
    type: "assistant",
    requestId: "native-log",
    message: { id: "msg_native", content: "native" },
  },
  {
    type: "assistant",
    requestId: "gateway-log",
    message: { id: "resp_foreign", content: "gateway" },
  },
];
const text = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

test("remove only foreign diagnostic anchors and preserve message content", () => {
  const result = clearForeignRequestIds(text);
  const parsed = result.text.trim().split("\n").map(JSON.parse);
  assert.equal(result.count, 1);
  assert.equal(parsed[1].requestId, "native-log");
  assert.equal(parsed[2].requestId, undefined);
  assert.deepEqual(parsed[2].message, rows[2].message);
  assert.deepEqual(parsed[0], rows[0]);
});

test("repairs only the ended session and keeps a private backup", () => {
  const root = tempDir("cn-repair-test-");
  const original = path.join(root, "claude");
  const dir = path.join(original, "projects", "project");
  const profile = path.join(root, "profile");
  const config = path.join(root, "config");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, "cn-ended-sessions"), id + "\n");
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, text);
  assert.equal(
    repairClaudeSessions({
      env: { CLAUDE_CONFIG_DIR: original, CN_CONFIG_HOME: config },
      profile,
    }),
    1,
  );
  assert.equal(clearForeignRequestIds(fs.readFileSync(file, "utf8")).count, 0);
  const backups = fs.readdirSync(path.join(config, "claude-session-backups"));
  assert.equal(backups.length, 1);
  const backup = path.join(config, "claude-session-backups", backups[0]);
  assert.equal(fs.readFileSync(backup, "utf8"), text);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
});

test("does not modify a session still open in another Claude process", () => {
  const root = tempDir("cn-repair-active-");
  const original = path.join(root, "claude");
  const dir = path.join(original, "projects", "project");
  const profile = path.join(root, "profile");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(original, "sessions"));
  fs.mkdirSync(profile);
  fs.writeFileSync(
    path.join(original, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: id }),
  );
  fs.writeFileSync(path.join(profile, "cn-ended-sessions"), id + "\n");
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, text);
  assert.equal(
    repairClaudeSessions({
      env: { CLAUDE_CONFIG_DIR: original, CN_CONFIG_HOME: root },
      profile,
    }),
    0,
  );
  assert.equal(fs.readFileSync(file, "utf8"), text);
});
