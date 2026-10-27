import type { Environment, Model } from "./types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CnError } from "./errors.js";

export function prepareClaudeContext({
  executable,
  available,
  forwarded = [],
  env = {},
  persistent = false,
}: {
  executable: string;
  available: Model[];
  forwarded?: string[];
  env?: Environment;
  persistent?: boolean;
}) {
  if (forwarded.some((arg) => ["--bare", "--safe-mode"].includes(arg))) {
    throw new CnError(
      "cn's context synchronization needs Claude Code mods. Remove --bare or --safe-mode to keep model switches accurate.",
    );
  }
  const version =
    executable &&
    spawnSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    }).stdout?.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (
    version &&
    (Number(version[1]) < 2 ||
      (Number(version[1]) === 2 &&
        (Number(version[2]) < 1 ||
          (Number(version[2]) === 1 && Number(version[3]) < 287))))
  ) {
    throw new CnError(
      "Context synchronization needs Claude Code 2.1.287 or newer. Run claude update, then launch through cn again.",
    );
  }
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "cn-claude-context-"),
  );
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    fs.mkdirSync(path.join(directory, ".claude-plugin"));
    fs.mkdirSync(path.join(directory, "hooks"));
    fs.writeFileSync(
      path.join(directory, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "cn-context",
        version: "0.1.0",
        author: { name: "Concentrate AI" },
        description:
          "Synchronizes model context, output limits, and reasoning compatibility through Concentrate.",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(directory, "hooks", "hooks.json"),
      JSON.stringify({ modules: ["./register.mjs"] }),
      { mode: 0o600 },
    );
    fs.copyFileSync(
      new URL("./claude-context/register.mjs", import.meta.url),
      path.join(directory, "hooks", "register.mjs"),
    );
    const capabilities = Object.fromEntries(
      available.map((m) => [
        m.id,
        {
          output:
            m.output !== null && Number.isSafeInteger(m.output) && m.output > 0
              ? m.output
              : null,
          reasoning:
            typeof m.reasoningSupport === "boolean" ? m.reasoningSupport : null,
          efforts: Array.isArray(m.efforts) ? m.efforts : null,
        },
      ]),
    );
    const preferences = {
      ...(persistent ? { dynamic: true } : {}),
      fixedContext: Boolean(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS),
      output: env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || null,
      disableThinking: env.CLAUDE_CODE_DISABLE_THINKING ?? null,
    };
    const limits = Object.fromEntries(
      available
        .filter(
          (m) =>
            m.context !== null &&
            Number.isSafeInteger(m.context) &&
            m.context > 0,
        )
        .map((m) => [m.id, m.context]),
    );
    fs.writeFileSync(
      path.join(directory, "hooks", "limits.mjs"),
      `export const limits = ${JSON.stringify(limits)};\nexport const capabilities = ${JSON.stringify(capabilities)};\nexport const preferences = ${JSON.stringify(preferences)};\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(directory, "README.md"),
      `# Concentrate context synchronization\n\nThis ${persistent ? "installed" : "session-only"} plugin updates Claude Code's context window, output cap, and reasoning compatibility using metadata supplied by cn. It follows the selected model after switches and before prompts and commands. Native Claude models retain their built-in handling. The plugin contains no API keys. ${persistent ? "Use cn reset claude to restore the prior configuration." : "It is removed when this launch exits."}\n`,
      { mode: 0o600 },
    );
    return { directory, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
