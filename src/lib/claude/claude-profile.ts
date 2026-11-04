import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir } from "../config/settings.js";
import type { Environment } from "../types.js";

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// One device ID for every cn claude launch, kept with cn's own state.
function deviceId(env: Environment) {
  const file = path.join(configDir(env), "claude-device-id");
  try {
    const saved = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(saved)) return saved;
  } catch {
    // not created yet
  }
  const id = randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, id + "\n", { mode: 0o600 });
  } catch {
    // Unsaved, this launch still works; the next one picks a new ID.
  }
  return id;
}

// Claude writes /model selections to its user settings even when launched with
// --settings. Isolate that writable state while sharing only session transcripts.
export function prepareClaudeProfile(env: Environment) {
  const home = env.HOME || os.homedir();
  const source = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "cn-claude-profile-"),
  );
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    // Copy user customizations rather than linking their writable settings. Do
    // not copy credentials: this profile authenticates with cn's key helper.
    for (const name of [
      "settings.json",
      "settings.local.json",
      "CLAUDE.md",
      "keybindings.json",
      "plugins",
      "skills",
      "commands",
      "agents",
      "hooks",
      "rules",
      "output-styles",
      "workflows",
      "themes",
    ]) {
      const from = path.join(source, name);
      if (fs.existsSync(from)) {
        const to = path.join(directory, name);
        if (fs.statSync(from).isFile()) fs.copyFileSync(from, to);
        else fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
      }
    }
    // An explicit CLAUDE_CONFIG_DIR moves Claude's global state file into it.
    const global = env.CLAUDE_CONFIG_DIR
      ? path.join(source, ".claude.json")
      : path.join(home, ".claude.json");
    const profileState = path.join(directory, ".claude.json");
    if (fs.existsSync(global)) fs.copyFileSync(global, profileState);
    // Claude sends a device ID with every request, and Concentrate's prompt
    // cache follows it. Without the user's own, Claude would invent a new one
    // each launch, so every session would start from a cold cache.
    let state: Record<string, unknown> | null = {};
    try {
      if (fs.existsSync(profileState)) {
        const parsed: unknown = JSON.parse(
          fs.readFileSync(profileState, "utf8"),
        );
        state =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
      }
    } catch {
      state = null; // a damaged copy is left as Claude would see it
    }
    if (state && !(typeof state.userID === "string" && state.userID)) {
      state.userID = deviceId(env);
      fs.writeFileSync(profileState, JSON.stringify(state, null, 2), {
        mode: 0o600,
      });
    }
    const projects = path.join(source, "projects");
    fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
    fs.symlinkSync(
      path.resolve(projects),
      path.join(directory, "projects"),
      "dir",
    );
    // SessionEnd identifies the conversation even when Claude's own picker or
    // /resume switches sessions. Record only IDs; the parent repairs after exit.
    const hook = path.join(directory, "cn-session-end.cjs");
    fs.writeFileSync(
      hook,
      `const fs = require("node:fs");\ntry { const data = JSON.parse(fs.readFileSync(0, "utf8")); if (typeof data.session_id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(data.session_id)) fs.appendFileSync(${JSON.stringify(path.join(directory, "cn-ended-sessions"))}, data.session_id + "\\n", { mode: 0o600 }); } catch {}\n`,
      { mode: 0o600 },
    );
    const endHook = `${shellQuote(process.execPath)} ${shellQuote(hook)}`;
    return { directory, cleanup, endHook };
  } catch (error) {
    cleanup();
    throw error;
  }
}
