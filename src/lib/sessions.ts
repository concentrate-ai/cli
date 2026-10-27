import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Environment, HarnessId } from "./types.js";
import { CnError } from "./errors.js";
import { configDir } from "./settings.js";
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

export function localSessions(
  target: "codex" | "pi",
  env: Environment,
  cwd = process.cwd(),
  directory?: string,
  {
    includeNonInteractive = false,
    includeScripted = false,
  }: { includeNonInteractive?: boolean; includeScripted?: boolean } = {},
) {
  let roots: string[];
  if (target === "codex")
    roots = [
      path.join(env.CODEX_HOME || path.join(home(env), ".codex"), "sessions"),
    ];
  else {
    const agent =
      env.PI_CODING_AGENT_DIR || path.join(home(env), ".pi", "agent");
    let configured: unknown;
    for (const settings of [
      path.join(agent, "settings.json"),
      path.join(cwd || process.cwd(), ".pi", "settings.json"),
    ]) {
      try {
        const value = record(
          JSON.parse(fs.readFileSync(settings, "utf8")),
        ).sessionDir;
        if (typeof value === "string") configured = value;
      } catch {
        /* Default directories remain available. */
      }
    }
    const override =
      directory ||
      env.PI_CODING_AGENT_SESSION_DIR ||
      (typeof configured === "string" ? configured : undefined);
    roots = override
      ? [
          path.resolve(override.replace(/^~(?=\/)/, home(env))),
          ...(directory ? [] : [path.join(configDir(env), "pi-sessions")]),
        ]
      : [
          path.join(agent, "sessions"),
          path.join(configDir(env), "pi-sessions"),
        ];
  }
  const sessionFiles = new Set(
    roots.flatMap((root) =>
      files(path.resolve(root), target === "codex" ? 3 : 1),
    ),
  );
  const sessions = [...sessionFiles].flatMap((file): SavedSession[] => {
    const entry = header(file);
    const meta =
      target === "codex" && entry?.type === "session_meta"
        ? record(entry.payload)
        : target === "pi" && entry?.type === "session"
          ? entry
          : null;
    if (!meta || typeof meta.id !== "string" || typeof meta.cwd !== "string")
      return [];
    // Like Codex itself, skip subagent threads and scripted runs (exec, mcp)
    // unless they were asked for; otherwise "latest" could be one of those.
    // `codex exec resume` exists to continue scripted runs, so it includes them.
    if (
      target === "codex" &&
      !includeNonInteractive &&
      (isRecord(meta.source) ||
        (!includeScripted && (meta.source === "exec" || meta.source === "mcp")))
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
  });
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
  if (target === "claude") return args;
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
      localSessions("codex", env, cwd, undefined, {
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
  const pi = target === "pi";
  const requested = optionValue(args, "--session", ...(pi ? [] : ["-s"]));
  const last = hasOption(args, "--continue", "-c");
  const picker = hasOption(
    args,
    pi ? "--resume" : "--cn-resume",
    ...(pi ? ["-r"] : []),
  );
  if (!requested && !last && !picker) return args;
  // Exact v2 IDs are validated by the model-switch API, which returns 404 for
  // missing sessions. Do not exclude older sessions because of a list limit.
  // The arguments stay where they are: a subcommand such as `run` owns them.
  if (!pi && requested && supportsStandalone(executable)) return args;
  let sessions: SavedSession[];
  if (
    pi &&
    requested &&
    (requested.includes("/") || requested.endsWith(".jsonl"))
  ) {
    const file = path.resolve(requested.replace(/^~(?=\/)/, home(env)));
    const value = header(file);
    if (value?.type !== "session" || typeof value.id !== "string")
      throw new CnError("The Pi session path is not a readable saved session.");
    sessions = [
      {
        id: value.id,
        file,
        cwd: typeof value.cwd === "string" ? value.cwd : process.cwd(),
        title: value.id,
        updated: fs.statSync(file).mtimeMs,
      },
    ];
  } else
    sessions = pi
      ? localSessions(
          "pi",
          env,
          process.cwd(),
          optionValue(args, "--session-dir"),
        )
      : openCodeSessions(executable, env);
  const matches = requested
    ? sessions.filter(
        (session) =>
          session.id === requested ||
          (pi && session.file === path.resolve(requested)) ||
          session.id.startsWith(requested),
      )
    : sessions;
  if (requested && matches.length !== 1)
    throw new CnError(
      matches.length
        ? "Session ID is ambiguous. Use its full ID."
        : `No saved ${target} session matches that ID. Check the project directory and session storage.`,
    );
  const chosen = requested
    ? matches[0]
    : await choose(target, matches, last, env);
  if (!chosen) return null;
  const remaining = without(
    args,
    ["--continue", "-c", "--resume", "-r", "--cn-resume"],
    ["--session", ...(pi ? [] : ["-s"])],
  );
  if (pi)
    return [
      "--session",
      chosen.file!,
      ...(hasOption(remaining, "--session-dir")
        ? []
        : ["--session-dir", path.dirname(chosen.file!)]),
      ...remaining,
    ];
  return withSessionFlag(remaining, chosen.id);
}

// OpenCode takes --session after a subcommand ("run --session ID ..."), and first
// for the interactive screen.
function withSessionFlag(args: string[], id: string) {
  if (args.length && !args[0].startsWith("-"))
    return [args[0], "--session", id, ...args.slice(1)];
  return ["--session", id, ...args];
}
