import { openCodeHeaders } from "../app-headers.js";
import type { Harness } from "../types.js";
import { spawnSync } from "node:child_process";

import { API_ROOT } from "../catalog.js";
import { opencodeConfig } from "../pickers.js";

// v2 talks to a shared background service unless told to run privately, and
// that service would ignore our config. v1 has no such flag and rejects it.
// Help text is the direct signal; the major version backs it up in case help changes.
export function supportsStandalone(executable: string) {
  const help = spawnSync(executable, ["--help"], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (/--standalone/.test(`${help.stdout ?? ""}${help.stderr ?? ""}`))
    return true;
  const out = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 10000,
  });
  const major = Number(/(\d+)\.\d+/.exec(out.stdout ?? "")?.[1]);
  return major >= 2;
}

// The flag goes after a subcommand ("run --standalone ..."), or first for the interactive screen.
export function withStandalone(forwarded: string[]) {
  if (forwarded.length && !forwarded[0].startsWith("-")) {
    return [forwarded[0], "--standalone", ...forwarded.slice(1)];
  }
  return ["--standalone", ...forwarded];
}

const adapter: Harness = {
  id: "opencode",
  label: "OpenCode",
  binary: "opencode",
  installHint:
    "Install OpenCode (https://opencode.ai), then run cn opencode again.",

  version(executable) {
    const out = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 10000,
    });
    return (out.stdout ?? "").trim().split("\n")[0] || null;
  },

  async prepare({ executable, model, key, available, forwarded, env }) {
    const modern = supportsStandalone(executable);
    const config = JSON.stringify(
      opencodeConfig(API_ROOT, model, available, {
        modern,
        headers: openCodeHeaders(env, modern),
      }),
    );
    return {
      args: modern ? withStandalone(forwarded) : forwarded,
      env: { OPENCODE_CONFIG_CONTENT: config, CONCENTRATE_API_KEY: key },
      cleanup() {},
    };
  },
};

export default adapter;
