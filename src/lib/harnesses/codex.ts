import {
  codexConfigArguments,
  codexHeaderConfig,
  codexProviderUsesHelper,
} from "../app-headers.js";
import { record } from "../validation.js";
import type { Harness, Environment } from "../types.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { API_ROOT } from "../catalog.js";
import { writeCodexCatalog } from "../pickers.js";
import {
  createdMs,
  filesIn,
  lastModelInTranscript,
  parseLine,
  regularFile,
} from "../recall.js";

// Codex files sessions by date. Check local and UTC days at both ends of the run.
function sessionDirs(env: Environment, startedAt: number) {
  const root = path.join(
    env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    "sessions",
  );
  const two = (n: number) => String(n).padStart(2, "0");
  const days = new Set<string>();
  for (const time of [startedAt, Date.now()]) {
    const d = new Date(time);
    days.add(`${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())}`);
    days.add(
      `${d.getUTCFullYear()}/${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())}`,
    );
  }
  return [...days].map((day) => path.join(root, day));
}

// Codex has no session-ID flag, so a session counts only if it was created during
// this run, in this directory, on the Concentrate provider.
function isThisRun(
  file: string,
  { cwd, startedAt }: { cwd: string; startedAt: number },
) {
  if (!regularFile(file) || createdMs(file) < startedAt - 1000) return false;
  const header = parseLine(fs.readFileSync(file, "utf8").split("\n", 1)[0]);
  const meta = header?.type === "session_meta" ? record(header.payload) : null;
  return Boolean(
    meta && meta.cwd === cwd && meta.model_provider === "concentrate",
  );
}

interface RunScope {
  env: Environment;
  cwd: string;
  startedAt: number;
}

// Newest first.
function thisRunSessions({ env, cwd, startedAt }: RunScope) {
  return sessionDirs(env, startedAt)
    .flatMap((dir) => filesIn(dir, ".jsonl"))
    .filter((file) => isThisRun(file, { cwd, startedAt }))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

// Codex prints "codex resume <id>", which fails outside cn: the thread belongs to
// the Concentrate provider, and plain Codex has no such provider without Configure.
function resumeCommand(scope: RunScope) {
  const [file] = thisRunSessions(scope);
  if (!file) return null;
  const header = parseLine(fs.readFileSync(file, "utf8").split("\n", 1)[0]);
  const id = record(header?.payload).id;
  return typeof id === "string" ? `cn codex resume ${id}` : null;
}

function recallCodexModel(scope: RunScope) {
  const files = thisRunSessions(scope);
  return files.length
    ? lastModelInTranscript(
        files[0],
        (entry) => entry.type === "turn_context" && record(entry.payload).model,
      )
    : null;
}

// Codex attaches to a shared background server that keeps closed threads
// loaded and then reports them as "open elsewhere". Older clients lack the flag.
function supportsNoDaemon(executable: string) {
  const help = spawnSync(executable, ["--help"], {
    encoding: "utf8",
    timeout: 10000,
  });
  return (help.stdout ?? "").includes("--no-daemon");
}

const adapter: Harness = {
  id: "codex",
  label: "Codex CLI",
  binary: "codex",
  installHint:
    "Install Codex CLI (npm install -g @openai/codex), then run cn codex again.",
  modelFlags: ["-m", "--model"],

  async prepare({ executable, model, key, available, forwarded, env }) {
    const startedAt = Date.now();
    const scope = (): RunScope => ({
      env,
      cwd: fs.realpathSync(process.cwd()),
      startedAt,
    });
    const userConfig = codexConfigArguments(forwarded);
    const overrides = [
      'model_provider="concentrate"',
      'model_providers.concentrate.name="Concentrate AI"',
      `model_providers.concentrate.base_url="${API_ROOT}/v1"`,
      // A saved credential helper (added for plain `codex resume`) already
      // supplies the key, and Codex refuses both on one provider.
      ...(codexProviderUsesHelper(env)
        ? []
        : ['model_providers.concentrate.env_key="CONCENTRATE_API_KEY"']),
      'model_providers.concentrate.wire_api="responses"',
      "model_providers.concentrate.requires_openai_auth=false",
    ];
    const headers = codexHeaderConfig("concentrate", env, forwarded);
    const headerOverrides = (["http_headers", "env_http_headers"] as const).map(
      (field) => {
        const table = Object.entries(headers[field])
          .map(
            ([name, value]) =>
              `${JSON.stringify(name)}=${JSON.stringify(value)}`,
          )
          .join(",");
        return `model_providers.concentrate.${field}={${table}}`;
      },
    );
    let directory = null;
    if (available.length > 0) {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), "cn-codex-"));
      try {
        const catalog = writeCodexCatalog(
          executable,
          available,
          path.join(directory, "models.json"),
          { env },
        );
        overrides.push(`model_catalog_json=${JSON.stringify(catalog)}`);
      } catch {
        console.error(
          "Codex rejected the temporary model catalog; using its normal picker.",
        );
      }
    }
    const allOverrides = [
      ...overrides,
      ...userConfig.overrides,
      ...headerOverrides,
    ];
    return {
      args: [
        ...(supportsNoDaemon(executable) ? ["--no-daemon"] : []),
        ...allOverrides.flatMap((value) => ["-c", value]),
        "-m",
        model,
        ...userConfig.args,
      ],
      env: { CONCENTRATE_API_KEY: key },
      recall: () => recallCodexModel(scope()),
      resumeHint: () => resumeCommand(scope()),
      cleanup() {
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
      },
    };
  },
};

export default adapter;
