import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Environment } from "./types.js";
import { configDir } from "./settings.js";
import { record } from "./validation.js";

const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// Only remove requestId from non-Anthropic assistant messages. Claude Code
// otherwise treats these as native diagnostics anchors when resuming normally.
export function clearForeignRequestIds(text: string) {
  let count = 0;
  const lines = text.split("\n").map((line) => {
    try {
      const entry = record(JSON.parse(line));
      const message = record(entry.message);
      if (
        entry.type === "assistant" &&
        typeof message.id === "string" &&
        !message.id.startsWith("msg_") &&
        typeof entry.requestId === "string" &&
        entry.requestId.length > 0
      ) {
        delete entry.requestId;
        count += 1;
        return JSON.stringify(entry);
      }
    } catch {
      // Leave malformed and incomplete records untouched.
    }
    return line;
  });
  return { text: lines.join("\n"), count };
}

function liveSession(id: string, source: string, ownProfile: string) {
  const roots = [path.join(source, "sessions")];
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith("cn-claude-profile-")) continue;
    const profile = path.join(os.tmpdir(), name);
    if (profile !== ownProfile) roots.push(path.join(profile, "sessions"));
  }
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!/^\d+\.json$/.test(name)) continue;
      try {
        const data = record(
          JSON.parse(fs.readFileSync(path.join(root, name), "utf8")),
        );
        if (data.sessionId !== id || typeof data.pid !== "number") continue;
        try {
          process.kill(data.pid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true;
        }
      } catch {
        // An unreadable session entry cannot be verified safely.
        return true;
      }
    }
  }
  return false;
}

export function repairClaudeSessions({
  env,
  profile,
}: {
  env: Environment;
  profile: string;
}) {
  const marker = path.join(profile, "cn-ended-sessions");
  if (!fs.existsSync(marker)) return -1;
  const ids = [...new Set(fs.readFileSync(marker, "utf8").split("\n"))].filter(
    (id) => SESSION_ID.test(id),
  );
  const source =
    env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
  const root = path.join(source, "projects");
  let total = 0;
  for (const id of ids) {
    if (liveSession(id, source, profile)) {
      console.error(
        `cn: session ${id} is open elsewhere; diagnostic cleanup skipped.`,
      );
      continue;
    }
    const files = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, `${id}.jsonl`))
      .filter((file) => {
        try {
          return fs.lstatSync(file).isFile();
        } catch {
          return false;
        }
      });
    if (files.length !== 1) continue;
    const file = files[0];
    const before = fs.statSync(file);
    const original = fs.readFileSync(file, "utf8");
    const result = clearForeignRequestIds(original);
    if (!result.count) continue;
    const after = fs.statSync(file);
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      console.error(
        `cn: session ${id} changed during cleanup; left unchanged.`,
      );
      continue;
    }
    const backups = path.join(configDir(env), "claude-session-backups");
    fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(backups, `${id}-${Date.now()}.jsonl`),
      original,
      { mode: 0o600, flag: "wx" },
    );
    const temporary = path.join(
      path.dirname(file),
      `.cn-session-${process.pid}-${id}`,
    );
    try {
      fs.writeFileSync(temporary, result.text, {
        mode: before.mode & 0o777,
        flag: "wx",
      });
      const latest = fs.statSync(file);
      if (
        before.ino !== latest.ino ||
        before.size !== latest.size ||
        before.mtimeMs !== latest.mtimeMs
      )
        throw new Error("session changed during cleanup");
      fs.renameSync(temporary, file);
      total += result.count;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return total;
}
