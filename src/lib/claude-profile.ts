import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Environment } from "./types.js";
import { isRecord } from "./validation.js";

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// The parts of Claude's global state file that hold MCP servers and the user's
// approvals for them. Nothing else in it is written back.
const PROJECT_MCP_FIELDS = [
  "mcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "enableAllProjectMcpServers",
];

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

function readState(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

// Applies only what the session changed (profile vs. its starting copy) onto
// the file as it is now, so edits made elsewhere in the meantime survive.
export function mergeMcpChanges(
  start: Record<string, unknown>,
  end: Record<string, unknown>,
  current: Record<string, unknown>,
) {
  const next = structuredClone(current);
  const object = (value: unknown) => (isRecord(value) ? value : {});
  const mergeServers = (
    from: unknown,
    to: unknown,
    into: Record<string, unknown>,
  ) => {
    const before = object(from);
    const after = object(to);
    let servers = object(into.mcpServers);
    let changed = false;
    for (const name of new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ])) {
      if (same(before[name], after[name])) continue;
      changed = true;
      servers = { ...servers };
      if (name in after) servers[name] = after[name];
      else delete servers[name];
    }
    if (changed) into.mcpServers = servers;
  };
  mergeServers(start.mcpServers, end.mcpServers, next);
  const startProjects = object(start.projects);
  const endProjects = object(end.projects);
  for (const dir of Object.keys(endProjects)) {
    const before = object(startProjects[dir]);
    const after = endProjects[dir];
    if (!isRecord(after)) continue;
    const projects = object(next.projects);
    const target = object(projects[dir]);
    let touched = false;
    for (const field of PROJECT_MCP_FIELDS) {
      if (same(before[field], after[field])) continue;
      touched = true;
      if (field === "mcpServers")
        mergeServers(before.mcpServers, after.mcpServers, target);
      else if (field in after) target[field] = after[field];
      else delete target[field];
    }
    if (touched) next.projects = { ...projects, [dir]: target };
  }
  return next;
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
    const startState = readState(global);
    if (fs.existsSync(global))
      fs.copyFileSync(global, path.join(directory, ".claude.json"));
    // MCP servers and approvals changed during the session are carried back to
    // the real file; the rest of the profile stays throwaway.
    const syncBack = () => {
      const end = readState(path.join(directory, ".claude.json"));
      const current = readState(global);
      if (!startState || !end || !current) return;
      const merged = mergeMcpChanges(startState, end, current);
      if (same(merged, current)) return;
      // Write through a symlinked file (dotfile managers) instead of replacing it.
      const target = fs.realpathSync(global);
      const temporary = `${target}.cn-${process.pid}`;
      const mode = fs.statSync(target).mode & 0o777;
      fs.writeFileSync(temporary, JSON.stringify(merged, null, 2), { mode });
      fs.renameSync(temporary, target);
    };
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
    return { directory, cleanup, endHook, syncBack };
  } catch (error) {
    cleanup();
    throw error;
  }
}
