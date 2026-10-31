import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CnError, EXIT } from "./errors.js";
import type { Environment } from "./types.js";
import { errorMessage, record } from "./validation.js";
import { listHarnesses } from "./harnesses/registry.js";
import {
  configDir,
  readStoredKeyOrNull,
  readJson,
  writeJson,
} from "./settings.js";
import { reconfigureTool, toolConfigured } from "./tool-config.js";
import { interactive, select } from "./ui/widgets.js";
import { version } from "./version.js";

const RELEASES = "https://github.com/concentrate-ai/cli/releases";
const LATEST_API =
  "https://api.github.com/repos/concentrate-ai/cli/releases/latest";
const TIMEOUT_MS = 15000;

function parts(v: string) {
  return v.split(".").map((n) => Number.parseInt(n, 10) || 0);
}

// True when `a` is a newer x.y.z than `b`.
export function isNewer(a: string, b: string) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

async function download(url: string, accept?: string, timeout = TIMEOUT_MS) {
  const response = await fetch(url, {
    headers: accept ? { accept } : {},
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
}

async function latestVersion() {
  try {
    const body: unknown = await (
      await download(LATEST_API, "application/vnd.github+json")
    ).json();
    const tag = record(body).tag_name;
    if (typeof tag !== "string" || !/^v?\d+\.\d+\.\d+$/.test(tag))
      throw new Error("no release tag");
    return tag.replace(/^v/, "");
  } catch (error) {
    throw new CnError(
      `Could not check for updates (${errorMessage(error)}). Check your connection and try again.`,
      EXIT.FAILURE,
    );
  }
}

const DAY_SECONDS = 24 * 3600;

// The newest release, from a once-a-day cache. With `wait: false` the cached
// answer comes back at once and a stale cache is refreshed in the background,
// so launching a tool never waits on the network. A failed check is not
// retried for an hour.
export async function knownLatest(
  env: Environment = process.env,
  { wait = true } = {},
) {
  const file = path.join(configDir(env), "update-check.json");
  let saved: Record<string, unknown> = {};
  try {
    saved = readJson(file, { private: false });
  } catch {
    // unreadable cache: check again
  }
  const cached = typeof saved.latest === "string" ? saved.latest : null;
  const checkedAt = typeof saved.checkedAt === "number" ? saved.checkedAt : 0;
  const age = Date.now() / 1000 - checkedAt;
  if (env.CN_OFFLINE || age < (cached ? DAY_SECONDS : 3600)) return cached;
  const check = (async () => {
    let latest = cached;
    try {
      const body: unknown = await (
        await download(LATEST_API, "application/vnd.github+json", 3000)
      ).json();
      const tag = record(body).tag_name;
      if (typeof tag === "string" && /^v?\d+\.\d+\.\d+$/.test(tag))
        latest = tag.replace(/^v/, "");
    } catch {
      // offline, rate limited, or GitHub unavailable
    }
    try {
      writeJson(file, { latest, checkedAt: Date.now() / 1000 });
    } catch {
      // the next launch simply checks again
    }
    return latest;
  })();
  return wait ? check : cached;
}

export async function updateNotice(env: Environment = process.env) {
  const latest = await knownLatest(env);
  return latest && isNewer(latest, version())
    ? `cn ${latest} is available (you have ${version()}). Run cn update.`
    : null;
}

// Asked at most once a day, and never again for a version the user skipped.
// Returns true when cn was updated, so the caller can stop and let them rerun.
export async function offerUpdate(env: Environment = process.env) {
  if (!interactive(env) || env.CI || env.CN_NO_UPDATE_CHECK) return false;
  const latest = await knownLatest(env, { wait: false });
  if (!latest || !isNewer(latest, version())) return false;
  const file = path.join(configDir(env), "update-prompt.json");
  let state: Record<string, unknown> = {};
  try {
    state = readJson(file, { private: false });
  } catch {
    // unreadable state: ask again
  }
  if (
    state.skipped === latest ||
    (typeof state.askAgainAfter === "number" &&
      Date.now() / 1000 < state.askAgainAfter)
  )
    return false;
  const choice = await select(
    {
      title: `cn ${latest} is available (you have ${version()})`,
      items: [
        { value: "now", label: "Update now" },
        {
          value: "later",
          label: "Remind me tomorrow",
          note: "Keep using this version for now.",
        },
        {
          value: "skip",
          label: "Skip this version",
          note: "Won't ask again until a newer one comes out.",
        },
      ],
      hints: [
        ["↑↓", "move"],
        ["↵", "choose"],
        ["esc", "later"],
      ],
    },
    env,
  );
  if (choice.cancel || choice.value === "later") {
    writeJson(file, {
      ...state,
      askAgainAfter: Date.now() / 1000 + DAY_SECONDS,
    });
    return false;
  }
  if (choice.value === "skip") {
    writeJson(file, { ...state, skipped: latest });
    return false;
  }
  let installed;
  try {
    installed = await updateCn({ refresh: false }, env);
  } catch (error) {
    // A failed update must not stop what the user was about to do.
    console.error(`${errorMessage(error)} Continuing with ${version()}.`);
    writeJson(file, {
      ...state,
      askAgainAfter: Date.now() / 1000 + DAY_SECONDS,
    });
    return false;
  }
  // Nothing newer after all (the cached answer was stale): carry on.
  if (!installed) return false;
  console.log("Updated. Run your command again to use the new version.");
  return true;
}

// Rewrites each permanently configured tool with the current model list and
// prices. A tool whose settings were edited by hand is left alone.
export async function refreshConfiguredTools(env: Environment = process.env) {
  const tools = listHarnesses()
    .map((h) => h.id)
    .filter((id) => toolConfigured(id, env));
  if (!tools.length) return 0;
  if (!readStoredKeyOrNull(env)) {
    console.log("No saved key, so configured tools were not refreshed.");
    return 0;
  }
  let problems = 0;
  for (const id of tools) {
    try {
      await reconfigureTool(id, env);
      console.log(`Refreshed ${id} with the latest models.`);
    } catch (error) {
      problems += 1;
      console.log(`Could not refresh ${id}: ${errorMessage(error)}`);
    }
  }
  return problems ? 1 : 0;
}

// Checks GitHub Releases and, unless `check` is set, runs that release's
// installer, the same one the install command uses.
export async function runUpdate(
  options: { check?: boolean; force?: boolean },
  env: Environment = process.env,
) {
  await updateCn(options, env);
  return 0;
}

// True only when a new version was installed.
async function updateCn(
  options: { check?: boolean; force?: boolean; refresh?: boolean },
  env: Environment,
) {
  const current = version();
  const latest = await latestVersion();
  // What GitHub says now replaces the daily cache, so a stale entry cannot
  // keep offering an update that does not exist.
  try {
    writeJson(path.join(configDir(env), "update-check.json"), {
      latest,
      checkedAt: Date.now() / 1000,
    });
  } catch {
    // only a cache
  }
  const newer = isNewer(latest, current);
  if (isNewer(current, latest)) {
    console.log(
      `cn ${current} is newer than the latest release (${latest}); nothing to install.`,
    );
    return false;
  }
  if (!newer && !options.force) {
    console.log(`cn ${current} is up to date.`);
    if (!options.check && options.refresh !== false)
      await refreshConfiguredTools(env);
    return false;
  }
  if (options.check) {
    console.log(
      newer
        ? `cn ${latest} is available (you have ${current}). Run cn update to install it.`
        : `cn ${current} is up to date.`,
    );
    return false;
  }
  console.log(`Updating cn ${current} to ${latest}...`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-update-"));
  try {
    const script = path.join(dir, "install.sh");
    try {
      const response = await download(
        `${RELEASES}/download/v${latest}/install.sh`,
      );
      fs.writeFileSync(script, await response.text(), { mode: 0o700 });
    } catch (error) {
      throw new CnError(
        `Could not download the installer (${errorMessage(error)}).`,
        EXIT.FAILURE,
      );
    }
    const result = spawnSync("bash", [script], {
      stdio: "inherit",
      env: { ...env, CN_INSTALL_VERSION: latest },
    });
    if (result.status !== 0)
      throw new CnError(
        "The update did not finish. Your current cn is unchanged.",
        EXIT.FAILURE,
      );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The new version refreshes the tools, so they get its own settings format.
  const launcher = path.join(env.HOME || os.homedir(), ".local", "bin", "cn");
  if (fs.existsSync(launcher))
    spawnSync(launcher, ["refresh"], { stdio: "inherit", env });
  else await refreshConfiguredTools(env);
  return true;
}
