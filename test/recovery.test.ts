import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect } from "vitest";
import {
  withSetupLock,
  hasNativeSetup,
} from "../src/lib/native-config-store.js";
import { readStoredKey, writeKey } from "../src/lib/settings.js";
import { fakeTool, runCn, tempDir } from "./helpers.js";

function home() {
  const dir = tempDir("cn-recovery-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const env = {
    HOME: dir,
    CN_CONFIG_HOME: path.join(dir, "cn"),
    XDG_CONFIG_HOME: path.join(dir, "xdg"),
    PATH: `${bin}:${path.dirname(process.execPath)}`,
  };
  fs.mkdirSync(env.CN_CONFIG_HOME, { mode: 0o700 });
  return { dir, bin, env };
}

const credentials = (env) => path.join(env.CN_CONFIG_HOME, "credentials.json");

test("a damaged saved key can be replaced with cn key and cn setup", () => {
  for (const [name, setup] of [
    [
      "not a valid key",
      (f) => fs.writeFileSync(f, '{"api_key":"has spaces"}', { mode: 0o600 }),
    ],
    [
      "readable by others",
      (f) => fs.writeFileSync(f, '{"api_key":"sk-old"}', { mode: 0o644 }),
    ],
    ["not JSON", (f) => fs.writeFileSync(f, "garbage", { mode: 0o600 })],
  ]) {
    for (const command of ["key", "setup"]) {
      const { env } = home();
      setup(credentials(env));
      const result = runCn([command, "--no-verify"], {
        env,
        input: "sk-brand-new\n",
      });
      expect(result.status, `${command} (${name}): ${result.stderr}`).toBe(0);
      expect(readStoredKey(env), `${command} (${name})`).toBe("sk-brand-new");
    }
  }
});

test("the first-run check treats a damaged key as missing instead of crashing", () => {
  const { bin, env } = home();
  fakeTool(bin, "claude");
  fs.writeFileSync(credentials(env), '{"api_key":"has spaces"}', {
    mode: 0o600,
  });
  const result = runCn(["claude"], { env });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/No API key found|cn key|cn setup/);
  expect(result.stderr).not.toMatch(/unexpected error/);
});

test("a config.json that other users can read does not stop cn", () => {
  const { bin, env } = home();
  const record = fakeTool(bin, "codex");
  writeKey("sk-test", env);
  fs.writeFileSync(
    path.join(env.CN_CONFIG_HOME, "config.json"),
    JSON.stringify({ models: { codex: "gpt-5.4" } }),
    { mode: 0o644 },
  );
  const shown = runCn(["config"], { env });
  expect(shown.status, shown.stderr).toBe(0);
  const result = runCn(["codex", "--", "exec", "hi"], {
    env: { ...env, CN_OFFLINE: "1" },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(record().args[record().args.indexOf("-m") + 1]).toBe("gpt-5.4");
});

test("a damaged restore receipt does not block logout", () => {
  const { env } = home();
  writeKey("sk-test", env);
  const receipts = path.join(env.CN_CONFIG_HOME, "tool-setups", "opencode");
  fs.mkdirSync(receipts, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(receipts, "restore.json"), "{not json", {
    mode: 0o600,
  });
  expect(hasNativeSetup(path.join(receipts, "restore.json"))).toBe(false);
  const result = runCn(["logout"], { env });
  expect(result.status, result.stderr).toBe(0);
  expect(fs.existsSync(credentials(env))).toBe(false);
});

test("logout removes the saved key even when a tool cannot be reset", () => {
  const { dir, env } = home();
  writeKey("sk-test", env);
  const receipts = path.join(env.CN_CONFIG_HOME, "tool-setups", "opencode");
  fs.mkdirSync(receipts, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(receipts, "restore.json"),
    JSON.stringify({ version: 1, active: true, files: {} }),
    { mode: 0o600 },
  );
  // Two OpenCode configs make the reset ambiguous, so resetting it throws.
  const opencode = path.join(env.XDG_CONFIG_HOME, "opencode");
  fs.mkdirSync(opencode, { recursive: true });
  fs.writeFileSync(path.join(opencode, "opencode.json"), "{}");
  fs.writeFileSync(path.join(opencode, "opencode.jsonc"), "{}");
  const result = runCn(["logout"], { env });
  expect(result.status, result.stderr).toBe(0);
  expect(fs.existsSync(credentials(env))).toBe(false);
  expect(result.stdout).toMatch(/could not be reset/);
  expect(dir).toBeTruthy();
});

test("a setup lock left by a dead process is cleared, a live one is respected", () => {
  const directory = tempDir("cn-lock-");
  const lock = path.join(directory, ".lock");
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;

  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "pid"), String(dead));
  expect(withSetupLock(directory, () => "ran")).toBe("ran");
  expect(fs.existsSync(lock), "the lock is released afterwards").toBe(false);

  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
  expect(() => withSetupLock(directory, () => "ran")).toThrow(/in progress/);
  fs.rmSync(lock, { recursive: true });

  // An old lock with no owner file (left by an older cn) is also stale.
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  expect(withSetupLock(directory, () => "ran")).toBe("ran");
});
