import { appHeaders } from "../app-headers.js";
import { record } from "../validation.js";
import type { Harness, Environment, Model } from "../types.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { API_ROOT } from "../catalog.js";
import { piConfig } from "../pickers.js";
import { filesIn, lastModelInTranscript, regularFile } from "../recall.js";
import { configDir } from "../settings.js";

const RESOURCE_DIRS = [
  "extensions",
  "skills",
  "prompt-templates",
  "prompt_templates",
  "themes",
  "packages",
];

function readObject(file: string): Record<string, unknown> {
  try {
    if (!fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
      return {};
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return record(value);
  } catch {
    return {};
  }
}

function writePrivate(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

// Builds a private agent dir that keeps the user's Pi settings, models, and
// resource dirs. Pi's auth.json is deliberately not copied.
function preparePiDir(
  directory: string,
  model: string,
  available: Model[],
  env: Environment,
) {
  const source =
    env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  writePrivate(path.join(directory, "settings.json"), {
    ...readObject(path.join(source, "settings.json")),
    defaultProvider: "concentrate",
    defaultModel: model,
  });
  const existing = readObject(path.join(source, "models.json")).providers;
  writePrivate(path.join(directory, "models.json"), {
    providers: {
      ...(existing && typeof existing === "object" ? existing : {}),
      ...piConfig(
        API_ROOT,
        available,
        appHeaders("pi", record(record(existing).concentrate).headers),
      ).providers,
    },
  });
  for (const name of RESOURCE_DIRS) {
    const original = path.join(source, name);
    if (fs.existsSync(original) && fs.statSync(original).isDirectory()) {
      fs.symlinkSync(original, path.join(directory, name), "dir");
    }
  }
}

const RESUMES = [
  "-c",
  "--continue",
  "-r",
  "--resume",
  "--session",
  "--session-id",
  "--fork",
  "--no-session",
];

const has = (forwarded: string[], flags: string[]) =>
  forwarded.some((arg) =>
    flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );

function optionValue(forwarded: string[], flag: string) {
  const at = forwarded.findIndex(
    (arg) => arg === flag || arg.startsWith(`${flag}=`),
  );
  if (at < 0) return null;
  return forwarded[at] === flag
    ? (forwarded[at + 1] ?? null)
    : forwarded[at].slice(flag.length + 1);
}

// Pi names a transcript "<time>_<session id>.jsonl" and records each model switch in it.
function recallPiModel({
  sessionDir,
  sessionId,
}: {
  sessionDir: string;
  sessionId: string;
}) {
  const file = filesIn(sessionDir, `_${sessionId}.jsonl`).find(regularFile);
  return file
    ? lastModelInTranscript(file, (entry) => {
        if (entry.type === "model_change" && entry.provider === "concentrate")
          return entry.modelId;
        const reply = record(entry.message);
        if (
          entry.type === "message" &&
          reply?.role === "assistant" &&
          reply.provider === "concentrate"
        )
          return reply.model;
        return null;
      })
    : null;
}

const adapter: Harness = {
  id: "pi",
  label: "Pi",
  binary: "pi",
  installHint:
    "Install Pi and make sure `pi` is on your PATH, then run cn pi again.",
  modelFlags: ["--model", "--provider"],

  async prepare({ model, key, available, forwarded, env }) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cn-pi-"));
    const cleanup = () =>
      fs.rmSync(directory, { recursive: true, force: true });
    try {
      preparePiDir(directory, model, available, env);
      const args = ["--provider", "concentrate", "--model", model];
      let sessionDir = optionValue(forwarded, "--session-dir");
      if (!sessionDir && !has(forwarded, ["--no-session"])) {
        sessionDir = path.join(configDir(env), "pi-sessions");
        fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
        args.push("--session-dir", sessionDir);
      }
      // A pinned ID names this run's transcript. Resumed sessions keep their own.
      const sessionId =
        sessionDir && !has(forwarded, RESUMES) ? randomUUID() : null;
      if (sessionId) args.push("--session-id", sessionId);
      return {
        args: [...args, ...forwarded],
        env: { CONCENTRATE_API_KEY: key, PI_CODING_AGENT_DIR: directory },
        recall: () =>
          sessionId && sessionDir
            ? recallPiModel({ sessionDir, sessionId })
            : null,
        cleanup,
      };
    } catch (error) {
      cleanup();
      throw error;
    }
  },
};

export default adapter;
