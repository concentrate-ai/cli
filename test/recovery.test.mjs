import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  withSetupLock,
  hasNativeSetup,
} from "../dist/lib/native-config-store.js";
import { readStoredKey, writeKey } from "../dist/lib/settings.js";
import { fakeTool, runCn, tempDir } from "./helpers.mjs";

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
      assert.equal(result.status, 0, `${command} (${name}): ${result.stderr}`);
      assert.equal(readStoredKey(env), "sk-brand-new", `${command} (${name})`);
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
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No API key found|cn key|cn setup/);
  assert.doesNotMatch(result.stderr, /unexpected error/);
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
  assert.equal(shown.status, 0, shown.stderr);
  const result = runCn(["codex", "--", "exec", "hi"], {
    env: { ...env, CN_OFFLINE: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(record().args[record().args.indexOf("-m") + 1], "gpt-5.4");
});

test("a damaged restore receipt does not block logout", () => {
  const { env } = home();
  writeKey("sk-test", env);
  const receipts = path.join(env.CN_CONFIG_HOME, "tool-setups", "opencode");
  fs.mkdirSync(receipts, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(receipts, "restore.json"), "{not json", {
    mode: 0o600,
  });
  assert.equal(hasNativeSetup(path.join(receipts, "restore.json")), false);
  const result = runCn(["logout"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(credentials(env)), false);
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
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(credentials(env)), false);
  assert.match(result.stdout, /could not be reset/);
  assert.ok(dir);
});

test("a setup lock left by a dead process is cleared, a live one is respected", () => {
  const directory = tempDir("cn-lock-");
  const lock = path.join(directory, ".lock");
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;

  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "pid"), String(dead));
  assert.equal(
    withSetupLock(directory, () => "ran"),
    "ran",
  );
  assert.equal(fs.existsSync(lock), false, "the lock is released afterwards");

  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
  assert.throws(() => withSetupLock(directory, () => "ran"), /in progress/);
  fs.rmSync(lock, { recursive: true });

  // An old lock with no owner file (left by an older cn) is also stale.
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  assert.equal(
    withSetupLock(directory, () => "ran"),
    "ran",
  );
});
