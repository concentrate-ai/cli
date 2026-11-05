import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir, writeJson } from "../config/settings.js";
import type { Environment } from "../types.js";
import { errorCode, isRecord, record } from "../validation.js";

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

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// Claude saves .mcp.json approvals and folder trust in the profile's copy.
// Carry them onto the user's file so they last between launches.
function carryApprovals(state: Record<string, unknown>, file: string) {
  let previous: unknown;
  try {
    previous = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // first launch, or a damaged copy: nothing to carry
  }
  const projects = record(state.projects);
  for (const [dir, value] of Object.entries(
    record(record(previous).projects),
  )) {
    if (!isRecord(value)) continue;
    const from = value;
    const to = record(projects[dir]);
    for (const key of ["enabledMcpjsonServers", "disabledMcpjsonServers"]) {
      const merged = [...new Set([...list(to[key]), ...list(from[key])])];
      if (merged.length) to[key] = merged;
    }
    if (from.hasTrustDialogAccepted === true) to.hasTrustDialogAccepted = true;
    projects[dir] = to;
  }
  state.projects = projects;
}

export const claudeProfileDir = (env: Environment) =>
  path.join(configDir(env), "claude-profile");

// Claude writes /model selections to its user settings even when launched with
// --settings, so cn keeps its own permanent profile; sign-ins made there last.
export function prepareClaudeProfile(env: Environment) {
  const home = env.HOME || os.homedir();
  const source = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const directory = claudeProfileDir(env);
  const scratch = (name: string) =>
    path.join(directory, `.${name}.cn-${randomBytes(6).toString("hex")}`);
  const ended = path.join(
    os.tmpdir(),
    `cn-claude-ended-${randomBytes(8).toString("hex")}`,
  );
  // Old copies are deleted at exit, not at launch, to keep startup fast.
  const old: string[] = [];
  const cleanup = () => {
    for (const file of [ended, ...old])
      fs.rmSync(file, { recursive: true, force: true });
  };
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
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
      const to = path.join(directory, name);
      const aside = scratch(name);
      try {
        fs.renameSync(to, aside);
        old.push(aside);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      if (fs.existsSync(from)) {
        if (fs.statSync(from).isFile()) fs.copyFileSync(from, to);
        else fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
      }
    }
    // An explicit CLAUDE_CONFIG_DIR moves Claude's global state file into it.
    const global = env.CLAUDE_CONFIG_DIR
      ? path.join(source, ".claude.json")
      : path.join(home, ".claude.json");
    const profileState = path.join(directory, ".claude.json");
    let state: Record<string, unknown> | null = {};
    if (fs.existsSync(global)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(global, "utf8"));
        state = isRecord(parsed) ? parsed : null;
      } catch {
        state = null;
      }
    }
    if (state) {
      carryApprovals(state, profileState);
      // Claude sends a device ID with every request, and Concentrate's prompt
      // cache follows it. Without the user's own, Claude would invent a new one
      // each launch, so every session would start from a cold cache.
      if (!(typeof state.userID === "string" && state.userID))
        state.userID = deviceId(env);
      writeJson(profileState, state);
    } else {
      fs.copyFileSync(global, profileState); // left damaged, as Claude would see it
    }
    const projects = path.resolve(source, "projects");
    fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
    const link = path.join(directory, "projects");
    const relink = scratch("projects");
    fs.symlinkSync(projects, relink, "dir");
    fs.renameSync(relink, link); // atomic, so a running session never loses it
    // SessionEnd identifies the conversation even when Claude's own picker or
    // /resume switches sessions. Record only IDs; the parent repairs after exit.
    const hook = path.join(directory, "cn-session-end.cjs");
    const rewrite = scratch("hook");
    fs.writeFileSync(
      rewrite,
      `const fs = require("node:fs");\ntry { const data = JSON.parse(fs.readFileSync(0, "utf8")); if (typeof data.session_id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(data.session_id)) fs.appendFileSync(process.argv[2], data.session_id + "\\n", { mode: 0o600 }); } catch {}\n`,
      { mode: 0o600 },
    );
    fs.renameSync(rewrite, hook); // a running session may be reading it
    const endHook = [process.execPath, hook, ended].map(shellQuote).join(" ");
    return { directory, ended, cleanup, endHook };
  } catch (error) {
    cleanup();
    throw error;
  }
}
