import { record, positiveTokens } from "../validation.js";
import type { Harness, Environment } from "../types.js";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { prepareClaudeContext } from "../claude-context.js";
import { API_ROOT } from "../catalog.js";
import { CLAUDE_BLANKED, CLAUDE_KEY_VAR, claudeSettings } from "../pickers.js";
import { filesIn, lastModelInTranscript, regularFile } from "../recall.js";

const RESUMES = [
  "-c",
  "--continue",
  "-r",
  "--resume",
  "--session-id",
  "--fork-session",
];

const resumes = (forwarded: string[]) =>
  forwarded.some((arg) =>
    RESUMES.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );

// Claude names each transcript after its session ID, under a per-directory folder.
function recallClaudeModel({
  env,
  sessionId,
}: {
  env: Environment;
  sessionId: string;
}) {
  const projects = path.join(
    env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
    "projects",
  );
  const file = filesIn(projects, "")
    .map((dir) => path.join(dir, `${sessionId}.jsonl`))
    .find(regularFile);
  return file
    ? lastModelInTranscript(
        file,
        (entry) => entry.type === "assistant" && record(entry.message).model,
      )
    : null;
}

const adapter: Harness = {
  id: "claude",
  label: "Claude Code",
  binary: "claude",
  installHint:
    "Install Claude Code (https://claude.com/claude-code), then run cn claude again.",
  modelFlags: ["--model"],

  async prepare({ executable, model, key, available, forwarded, env }) {
    // Pinning the session ID tells cn exactly which transcript is this run's.
    // A resumed session already has an ID, so nothing is remembered for it.
    const sessionId = resumes(forwarded) ? null : randomUUID();
    // The key travels in the child's environment only, under a name only cn's helper reads.
    // Match GLM coding sessions with GLM classification, as requested. The
    // caller can choose a different classifier explicitly. Requires 2.1.302+.
    const classifierModel =
      env.CLAUDE_CODE_AUTO_MODE_MODEL ||
      ((model.split("/").pop() ?? model).startsWith("glm-")
        ? model
        : undefined);
    // Seed the startup window, then a session-only mod follows model switches.
    // An explicit user override stays fixed and takes priority.
    const catalogModel =
      available.find((entry) => entry.id === model && entry.context) ||
      available.find(
        (entry) => entry.id === model.split("/").pop() && entry.context,
      );
    const contextTokens =
      env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ||
      (!/claude-|\[1m\]/i.test(model) &&
      positiveTokens(catalogModel?.context) !== null
        ? String(catalogModel?.context)
        : undefined);
    // Claude models are sent as Claude Code expects. Other models cannot return
    // the server-side auto mode checks, so skip them and the notice about them.
    const autoModeServer =
      env.CLAUDE_CODE_AUTO_MODE_SERVER ??
      (/claude-/i.test(model) ? undefined : "0");
    const settings = claudeSettings(API_ROOT, model, available);
    if (autoModeServer !== undefined)
      settings.env.CLAUDE_CODE_AUTO_MODE_SERVER = autoModeServer;
    // The fresh session plugin takes precedence over any saved catalog/plugin.
    settings.enabledPlugins = { "cn-context@concentrate-cn": false };
    if (classifierModel)
      settings.env.CLAUDE_CODE_AUTO_MODE_MODEL = classifierModel;
    if (env.CLAUDE_CODE_MAX_CONTEXT_TOKENS)
      settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = contextTokens;
    const context = prepareClaudeContext({
      executable,
      available,
      forwarded,
      env,
    });
    return {
      args: [
        "--settings",
        JSON.stringify(settings),
        "--model",
        model,
        ...(sessionId ? ["--session-id", sessionId] : []),
        ...(context ? ["--plugin-dir", context.directory] : []),
        ...forwarded,
      ],
      env: {
        ANTHROPIC_BASE_URL: API_ROOT,
        ANTHROPIC_MODEL: model,
        [CLAUDE_KEY_VAR]: key,
        ...(autoModeServer !== undefined
          ? { CLAUDE_CODE_AUTO_MODE_SERVER: autoModeServer }
          : {}),
        ...(classifierModel
          ? { CLAUDE_CODE_AUTO_MODE_MODEL: classifierModel }
          : {}),
        ...(contextTokens
          ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: contextTokens }
          : {}),
      },
      // Also dropped from the inherited environment, so nothing the shell exports
      // reaches Concentrate or routes around it.
      unset: CLAUDE_BLANKED,
      recall: () => (sessionId ? recallClaudeModel({ env, sessionId }) : null),
      cleanup() {
        context?.cleanup();
      },
    };
  },
};

export default adapter;
