import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Environment, HarnessId } from "./types.js";
import { CnError } from "./errors.js";
import { isRecord, record } from "./validation.js";
import { interactive, select } from "./ui/widgets.js";
import { supportsStandalone } from "./harnesses/opencode-cli.js";
import { fullScreenActive, openScreen } from "./ui/screen.js";

export interface SavedSession {
  id: string;
  file?: string;
  cwd: string;
  title: string;
  updated: number;
}

const home = (env: Environment) => env.HOME || os.homedir();
const safeText = (text: string) =>
  [...text]
    .filter((char) => char >= " " && !(char >= "\x7f" && char <= "\x9f"))
    .join("");
const sameDirectory = (a: string, b: string) => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
};

// Read only the first line (bounded); never load conversation bodies to populate
// a menu. Codex's session_meta line embeds the full instructions and can be large.
const HEADER_LIMIT = 4 * 1024 * 1024;
function header(file: string) {
  let fd;
  try {
    if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile())
      return null;
    fd = fs.openSync(file, "r");
    const chunks: Buffer[] = [];
    let position = 0;
    while (position < HEADER_LIMIT) {
      const buffer = Buffer.alloc(65536);
      const count = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!count) break;
      const chunk = buffer.subarray(0, count);
      const newline = chunk.indexOf(10);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        break;
      }
      chunks.push(chunk);
      position += count;
    }
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function files(root: string, depth: number): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(root, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) return [file];
      return entry.isDirectory() && depth > 0 ? files(file, depth - 1) : [];
    });
  } catch {
    return [];
  }
}

export function optionValue(args: string[], ...names: string[]) {
  const end = args.indexOf("--");
  const options = end < 0 ? args : args.slice(0, end);
  for (let i = 0; i < options.length; i++) {
    for (const name of names) {
      if (options[i] === name) return options[i + 1];
      if (options[i].startsWith(`${name}=`))
        return options[i].slice(name.length + 1);
    }
  }
  return undefined;
}

export function hasOption(args: string[], ...names: string[]) {
  const end = args.indexOf("--");
  return (end < 0 ? args : args.slice(0, end)).some((arg) =>
    names.some((name) => arg === name || arg.startsWith(`${name}=`)),
  );
}

export function codexSessions(
  env: Environment,
  cwd = process.cwd(),
  {
    includeNonInteractive = false,
    includeScripted = false,
  }: { includeNonInteractive?: boolean; includeScripted?: boolean } = {},
) {
  const root = path.join(
    env.CODEX_HOME || path.join(home(env), ".codex"),
    "sessions",
  );
  const sessions = files(path.resolve(root), 3).flatMap(
    (file): SavedSession[] => {
      const entry = header(file);
      const meta =
        entry?.type === "session_meta" ? record(entry.payload) : null;
      if (!meta || typeof meta.id !== "string" || typeof meta.cwd !== "string")
        return [];
      // Like Codex itself, skip subagent threads and scripted runs (exec, mcp)
      // unless they were asked for; otherwise "latest" could be one of those.
      // `codex exec resume` exists to continue scripted runs, so it includes them.
      if (
        !includeNonInteractive &&
        (isRecord(meta.source) ||
          (!includeScripted &&
            (meta.source === "exec" || meta.source === "mcp")))
      )
        return [];
      let updated: number;
      try {
        updated = fs.statSync(file).mtimeMs;
      } catch {
        return [];
      }
      return [
        {
          id: meta.id,
          cwd: meta.cwd,
          title: meta.id,
          file,
          updated,
        },
      ];
    },
  );
  // Both subscription and API sessions are eligible. Native provider filtering
  // would hide the very conversation the user wants to continue through cn.
  return sessions
    .filter((session) => !cwd || sameDirectory(session.cwd, cwd))
    .sort((a, b) => b.updated - a.updated);
}

export function openCodeSessions(
  executable: string,
  env: Environment,
): SavedSession[] {
  try {
    const modern = supportsStandalone(executable);
    const output = execFileSync(
      executable,
      [
        "session",
        "list",
        ...(modern ? ["--standalone"] : []),
        "--format",
        "json",
        "--max-count",
        "1000",
      ],
      {
        env,
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const data: unknown = JSON.parse(output);
    if (!Array.isArray(data)) throw new Error("Unexpected session list");
    return data
      .flatMap((item): SavedSession[] => {
        const value = record(item);
        if (typeof value.id !== "string") return [];
        const time = record(value.time);
        return [
          {
            id: value.id,
            cwd:
              typeof value.directory === "string"
                ? value.directory
                : process.cwd(),
            title:
              typeof value.title === "string"
                ? safeText(value.title)
                : value.id,
            updated: Number(value.updated ?? time.updated ?? 0),
          },
        ];
      })
      .sort((a, b) => b.updated - a.updated);
  } catch {
    throw new CnError(
      "Could not list OpenCode sessions. Run opencode session list to check its local session store.",
    );
  }
}

async function choose(
  target: HarnessId,
  sessions: SavedSession[],
  last: boolean,
  env: Environment,
) {
  if (!sessions.length)
    throw new CnError(
      `No saved ${target} sessions found for this project. Run cn from the original project directory or pass a session ID/path.`,
    );
  if (last) return sessions[0];
  if (!interactive(env))
    throw new CnError(
      `Choose a session with cn ${target} resume <session-id>, or use cn ${target} continue for the latest.`,
    );
  const screen = fullScreenActive() ? null : openScreen();
  try {
    const choice = await select(
      {
        title: `Resume ${target}`,
        filterable: true,
        items: sessions.map((session, index) => ({
          value: String(index),
          label: safeText(session.title),
          note: `${new Date(session.updated).toLocaleString()} · ${safeText(path.basename(session.cwd))}`,
        })),
        detail: () => [
          "Continue this saved conversation through Concentrate. New requests use your Concentrate key and API billing.",
        ],
      },
      env,
    );
    return choice.cancel ? null : sessions[Number(choice.value)];
  } finally {
    screen?.close();
  }
}

export async function chooseOpenCodeSession(
  executable: string,
  env: Environment,
) {
  return choose("opencode", openCodeSessions(executable, env), false, env);
}

function without(args: string[], flags: string[], valued: string[] = []) {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") {
      result.push(...args.slice(i));
      break;
    }
    if (flags.includes(args[i])) continue;
    const name = valued.find(
      (flag) => args[i] === flag || args[i].startsWith(`${flag}=`),
    );
    if (name) {
      if (args[i] === name) i++;
      continue;
    }
    result.push(args[i]);
  }
  return result;
}

export async function resolveSessionArgs(
  target: HarnessId,
  executable: string,
  args: string[],
  env: Environment,
): Promise<string[] | null> {
  if (target === "claude" || target === "pi") return args;
  if (target === "codex") {
    const index =
      args[0] === "resume"
        ? 0
        : args[0] === "exec" && args[1] === "resume"
          ? 1
          : -1;
    if (index < 0) return args;
    const rest = args.slice(index + 1);
    // An explicit ID/name belongs to Codex; retain its native argument grammar.
    if (rest[0] && !rest[0].startsWith("-")) return args;
    if (
      !hasOption(rest, "--last") &&
      rest.some(
        (arg) =>
          !["--last", "--all", "--include-non-interactive"].includes(arg),
      )
    )
      return args;
    const cwd = hasOption(rest, "--all") ? "" : process.cwd();
    const chosen = await choose(
      target,
      codexSessions(env, cwd, {
        includeNonInteractive: hasOption(rest, "--include-non-interactive"),
        includeScripted: index === 1,
      }),
      hasOption(rest, "--last"),
      env,
    );
    return chosen
      ? [
          ...args.slice(0, index + 1),
          chosen.id,
          // `exec resume` does not accept the picker's non-interactive flag.
          ...rest.filter(
            (arg) =>
              arg !== "--last" &&
              !(index === 1 && arg === "--include-non-interactive"),
          ),
        ]
      : null;
  }
  if (optionValue(args, "--session", "-s")) return args;
  const last = hasOption(args, "--continue", "-c");
  if (!last) return args;
  // OpenCode v2 persists a session's model. Resolve its native --continue to
  // an ID so the adapter can select Concentrate before the session starts.
  // OpenCode owns the session list; cn never presents a separate picker.
  const sessions = openCodeSessions(executable, env);
  const chosen = await choose(target, sessions, true, env);
  if (!chosen) return null;
  const remaining = without(args, ["--continue", "-c"], ["--session", "-s"]);
  return withSessionFlag(remaining, chosen.id);
}

// OpenCode takes --session after a subcommand ("run --session ID ..."), and first
// for the interactive screen.
function withSessionFlag(args: string[], id: string) {
  if (args.length && !args[0].startsWith("-"))
    return [args[0], "--session", id, ...args.slice(1)];
  return ["--session", id, ...args];
}
