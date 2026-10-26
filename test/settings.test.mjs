import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  DEFAULT_MODELS,
  deleteStoredKey,
  readPreferences,
  readStoredKey,
  resolveKey,
  writeKey,
  writePreferences,
} from "../dist/lib/settings.js";
import { tempDir } from "./helpers.mjs";

const envFor = (dir, extra = {}) => ({ CN_CONFIG_HOME: dir, ...extra });

test("writeKey stores the key owner-only and readStoredKey returns it", () => {
  const dir = tempDir();
  writeKey("  sk-abc  ", envFor(dir));
  const file = path.join(dir, "credentials.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(readStoredKey(envFor(dir)), "sk-abc");
});

test("resolveKey prefers the stored key, then the environment, then reports missing", () => {
  const dir = tempDir();
  assert.deepEqual(resolveKey(envFor(dir)), { key: null, source: "missing" });
  assert.deepEqual(
    resolveKey(envFor(dir, { CONCENTRATE_API_KEY: "env-key" })),
    {
      key: "env-key",
      source: "environment",
    },
  );
  writeKey("stored-key", envFor(dir));
  assert.equal(
    resolveKey(envFor(dir, { CONCENTRATE_API_KEY: "env-key" })).source,
    "stored",
  );
});

test("a group-readable credentials file is refused", () => {
  const dir = tempDir();
  writeKey("k", envFor(dir));
  fs.chmodSync(path.join(dir, "credentials.json"), 0o644);
  assert.throws(() => readStoredKey(envFor(dir)), /accessible to others/);
});

test("a symlinked credentials file is refused", () => {
  const dir = tempDir();
  const target = path.join(dir, "elsewhere.json");
  fs.writeFileSync(target, '{"api_key":"x"}', { mode: 0o600 });
  fs.symlinkSync(target, path.join(dir, "credentials.json"));
  assert.throws(() => readStoredKey(envFor(dir)), /symbolic link/);
});

test("deleteStoredKey reports whether anything was removed", () => {
  const dir = tempDir();
  assert.equal(deleteStoredKey(envFor(dir)), false);
  writeKey("k", envFor(dir));
  assert.equal(deleteStoredKey(envFor(dir)), true);
  assert.equal(readStoredKey(envFor(dir)), null);
});

test("preferences default, persist, and ignore blank values", () => {
  const dir = tempDir();
  assert.deepEqual(readPreferences(envFor(dir)), DEFAULT_MODELS);
  writePreferences(
    { ...DEFAULT_MODELS, claude: "claude-opus-4-6" },
    envFor(dir),
  );
  assert.equal(readPreferences(envFor(dir)).claude, "claude-opus-4-6");
  fs.writeFileSync(path.join(dir, "config.json"), '{"models":{"pi":"  "}}', {
    mode: 0o600,
  });
  assert.equal(readPreferences(envFor(dir)).pi, DEFAULT_MODELS.pi);
});

test("writePreferences rejects unknown tools and empty IDs", () => {
  const dir = tempDir();
  assert.throws(
    () => writePreferences({ claude: "x" }, envFor(dir)),
    /every supported tool/,
  );
  assert.throws(
    () => writePreferences({ ...DEFAULT_MODELS, pi: " " }, envFor(dir)),
    /Not a valid model ID/,
  );
  assert.throws(
    () =>
      writePreferences(
        { ...DEFAULT_MODELS, pi: "--dangerously-skip-permissions" },
        envFor(dir),
      ),
    /Not a valid model ID/,
  );
  assert.throws(
    () =>
      writePreferences({ ...DEFAULT_MODELS, pi: "x\u001b[31m" }, envFor(dir)),
    /Not a valid model ID/,
  );
});

test("needsSetup is true only while there is no key", async () => {
  const { needsSetup } = await import("../dist/lib/settings.js");
  const dir = tempDir();
  assert.equal(needsSetup(envFor(dir)), true);
  assert.equal(
    needsSetup(envFor(dir, { CONCENTRATE_API_KEY: "env-key" })),
    false,
    "an environment key is enough",
  );
  writeKey("stored", envFor(dir));
  assert.equal(needsSetup(envFor(dir)), false, "no model choice is required");
});

test("maskKey hides the key and shows only the last four characters", async () => {
  const { maskKey } = await import("../dist/lib/commands.js");
  assert.equal(maskKey("sk-live-abcdef123456"), "••••••••3456");
  assert.equal(maskKey("short"), "••••••••");
});

test("a tampered config.json cannot smuggle a flag or escape codes in as a model", () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({
      models: {
        claude: "--dangerously-skip-permissions",
        pi: "x\u001b]0;t\u0007",
      },
    }),
    { mode: 0o600 },
  );
  const models = readPreferences(envFor(dir));
  assert.equal(models.claude, DEFAULT_MODELS.claude);
  assert.equal(models.pi, DEFAULT_MODELS.pi);
});

test("keys: trimmed, and anything with spaces or control characters is refused without echoing it", async () => {
  const { environmentKey } = await import("../dist/lib/settings.js");
  const dir = tempDir();
  assert.equal(
    resolveKey(envFor(dir, { CONCENTRATE_API_KEY: "  sk-env\n" })).key,
    "sk-env",
  );
  assert.equal(
    environmentKey(envFor(dir, { CONCENTRATE_API_KEY: "   " })),
    null,
  );
  for (const bad of ["sk bad", "sk\u0000nul", "sk\u001b[2J"]) {
    assert.throws(
      () => writeKey(bad, envFor(dir)),
      (error) =>
        /doesn't look like an API key/.test(error.message) &&
        !error.message.includes(bad),
    );
    assert.throws(
      () => resolveKey(envFor(dir, { CONCENTRATE_API_KEY: bad })),
      (error) => !error.message.includes(bad),
    );
  }
  fs.writeFileSync(
    path.join(dir, "credentials.json"),
    JSON.stringify({ api_key: "SECRET-1234\u0000" }),
    { mode: 0o600 },
  );
  assert.throws(
    () => readStoredKey(envFor(dir)),
    (error) =>
      /not valid/.test(error.message) && !error.message.includes("SECRET"),
  );
});

test("CN_CONFIG_HOME is resolved to an absolute path, and an existing directory keeps its mode", async () => {
  const { configDir } = await import("../dist/lib/settings.js");
  assert.ok(path.isAbsolute(configDir({ CN_CONFIG_HOME: "relative/dir" })));
  assert.equal(
    configDir({ CN_CONFIG_HOME: "~" }),
    (await import("node:os")).homedir(),
  );
  const shared = tempDir();
  fs.chmodSync(shared, 0o755);
  writeKey("sk-1", envFor(shared));
  assert.equal(fs.statSync(shared).mode & 0o777, 0o755);
  assert.equal(
    fs.statSync(path.join(shared, "credentials.json")).mode & 0o777,
    0o600,
  );
});
