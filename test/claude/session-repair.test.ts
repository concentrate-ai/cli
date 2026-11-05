import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import {
  clearForeignRequestIds,
  repairClaudeSessions,
} from "../../src/lib/claude/claude-session-repair.js";
import { tempDir } from "../helpers.js";

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
const parseLines = (jsonl) => jsonl.trim().split("\n").map(JSON.parse);

test("remove only foreign diagnostic anchors and preserve message content", () => {
  const result = clearForeignRequestIds(text);
  const parsed = parseLines(result.text);
  expect(result.count).toBe(1);
  expect(parsed[1].requestId).toBe("native-log");
  expect(parsed[2].requestId).toBe(undefined);
  expect(parsed[2].message).toStrictEqual(rows[2].message);
  expect(parsed[0]).toStrictEqual(rows[0]);
});

test("repairs only the ended session and keeps a private backup", () => {
  const root = tempDir("cn-repair-test-");
  const original = path.join(root, "claude");
  const dir = path.join(original, "projects", "project");
  const config = path.join(root, "config");
  fs.mkdirSync(dir, { recursive: true });
  const ended = path.join(root, "ended");
  fs.writeFileSync(ended, id + "\n");
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, text);
  expect(
    repairClaudeSessions({
      env: { CLAUDE_CONFIG_DIR: original, CN_CONFIG_HOME: config },
      ended,
    }),
  ).toBe(1);
  expect(clearForeignRequestIds(fs.readFileSync(file, "utf8")).count).toBe(0);
  const backups = fs.readdirSync(path.join(config, "claude-session-backups"));
  expect(backups.length).toBe(1);
  const backup = path.join(config, "claude-session-backups", backups[0]);
  expect(fs.readFileSync(backup, "utf8")).toBe(text);
  expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
});

test("does not modify a session still open in another Claude process", () => {
  const root = tempDir("cn-repair-active-");
  const original = path.join(root, "claude");
  const dir = path.join(original, "projects", "project");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(original, "sessions"));
  fs.writeFileSync(
    path.join(original, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: id }),
  );
  const ended = path.join(root, "ended");
  fs.writeFileSync(ended, id + "\n");
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, text);
  expect(
    repairClaudeSessions({
      env: { CLAUDE_CONFIG_DIR: original, CN_CONFIG_HOME: root },
      ended,
    }),
  ).toBe(0);
  expect(fs.readFileSync(file, "utf8")).toBe(text);
});

test("does not modify a session still open in another cn claude", () => {
  const root = tempDir("cn-repair-cn-active-");
  const original = path.join(root, "claude");
  const dir = path.join(original, "projects", "project");
  const sessions = path.join(root, "cn", "claude-profile", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(
    path.join(sessions, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: id }),
  );
  const ended = path.join(root, "ended");
  fs.writeFileSync(ended, id + "\n");
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, text);
  expect(
    repairClaudeSessions({
      env: {
        CLAUDE_CONFIG_DIR: original,
        CN_CONFIG_HOME: path.join(root, "cn"),
      },
      ended,
    }),
  ).toBe(0);
  expect(fs.readFileSync(file, "utf8")).toBe(text);
});
