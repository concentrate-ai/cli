import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";

import {
  DEFAULT_MODELS,
  deleteStoredKey,
  readPreferences,
  readStoredKey,
  resolveKey,
  writeKey,
  writePreferences,
  needsSetup,
  environmentKey,
  configDir,
} from "../../src/lib/config/settings.js";
import { tempDir } from "../helpers.js";
import { homedir } from "node:os";

const envFor = (dir, extra = {}) => ({ CN_CONFIG_HOME: dir, ...extra });

test("writeKey stores the key owner-only and readStoredKey returns it", () => {
  const dir = tempDir();
  writeKey("  sk-abc  ", envFor(dir));
  const file = path.join(dir, "credentials.json");
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  expect(readStoredKey(envFor(dir))).toBe("sk-abc");
});

test("resolveKey prefers the stored key, then the environment, then reports missing", () => {
  const dir = tempDir();
  expect(resolveKey(envFor(dir))).toStrictEqual({
    key: null,
    source: "missing",
  });
  expect(
    resolveKey(envFor(dir, { CONCENTRATE_API_KEY: "env-key" })),
  ).toStrictEqual({
    key: "env-key",
    source: "environment",
  });
  writeKey("stored-key", envFor(dir));
  expect(
    resolveKey(envFor(dir, { CONCENTRATE_API_KEY: "env-key" })).source,
  ).toBe("stored");
});

test("a group-readable credentials file is refused", () => {
  const dir = tempDir();
  writeKey("k", envFor(dir));
  fs.chmodSync(path.join(dir, "credentials.json"), 0o644);
  expect(() => readStoredKey(envFor(dir))).toThrow(/accessible to others/);
});

test("a symlinked credentials file is refused", () => {
  const dir = tempDir();
  const target = path.join(dir, "elsewhere.json");
  fs.writeFileSync(target, '{"api_key":"x"}', { mode: 0o600 });
  fs.symlinkSync(target, path.join(dir, "credentials.json"));
  expect(() => readStoredKey(envFor(dir))).toThrow(/symbolic link/);
});

test("deleteStoredKey reports whether anything was removed", () => {
  const dir = tempDir();
  expect(deleteStoredKey(envFor(dir))).toBe(false);
  writeKey("k", envFor(dir));
  expect(deleteStoredKey(envFor(dir))).toBe(true);
  expect(readStoredKey(envFor(dir))).toBe(null);
});

test("preferences default, persist, and ignore blank values", () => {
  const dir = tempDir();
  expect(readPreferences(envFor(dir))).toStrictEqual(DEFAULT_MODELS);
  writePreferences(
    { ...DEFAULT_MODELS, claude: "claude-opus-4-6" },
    envFor(dir),
  );
  expect(readPreferences(envFor(dir)).claude).toBe("claude-opus-4-6");
  fs.writeFileSync(path.join(dir, "config.json"), '{"models":{"pi":"  "}}', {
    mode: 0o600,
  });
  expect(readPreferences(envFor(dir)).pi).toBe(DEFAULT_MODELS.pi);
});

test("writePreferences rejects unknown tools and empty IDs", () => {
  const dir = tempDir();
  expect(() => writePreferences({ claude: "x" }, envFor(dir))).toThrow(
    /every supported tool/,
  );
  expect(() =>
    writePreferences({ ...DEFAULT_MODELS, pi: " " }, envFor(dir)),
  ).toThrow(/Not a valid model ID/);
  expect(() =>
    writePreferences(
      { ...DEFAULT_MODELS, pi: "--dangerously-skip-permissions" },
      envFor(dir),
    ),
  ).toThrow(/Not a valid model ID/);
  expect(() =>
    writePreferences({ ...DEFAULT_MODELS, pi: "x\u001b[31m" }, envFor(dir)),
  ).toThrow(/Not a valid model ID/);
});

test("needsSetup is true only while there is no key", async () => {
  const dir = tempDir();
  expect(needsSetup(envFor(dir))).toBe(true);
  expect(
    needsSetup(envFor(dir, { CONCENTRATE_API_KEY: "env-key" })),
    "an environment key is enough",
  ).toBe(false);
  writeKey("stored", envFor(dir));
  expect(needsSetup(envFor(dir)), "no model choice is required").toBe(false);
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
  expect(models.claude).toBe(DEFAULT_MODELS.claude);
  expect(models.pi).toBe(DEFAULT_MODELS.pi);
});

test("keys: trimmed, and anything with spaces or control characters is refused without echoing it", async () => {
  const dir = tempDir();
  expect(
    resolveKey(envFor(dir, { CONCENTRATE_API_KEY: "  sk-env\n" })).key,
  ).toBe("sk-env");
  expect(environmentKey(envFor(dir, { CONCENTRATE_API_KEY: "   " }))).toBe(
    null,
  );
  fs.writeFileSync(
    path.join(dir, "credentials.json"),
    JSON.stringify({ api_key: "SECRET-1234\u0000" }),
    { mode: 0o600 },
  );
  expect(() => readStoredKey(envFor(dir))).toThrow(/not valid/);
  expect(() => readStoredKey(envFor(dir))).toThrow(
    expect.objectContaining({ message: expect.not.stringContaining("SECRET") }),
  );
});

test.each(["sk bad", "sk\u0000nul", "sk\u001b[2J"])(
  "keys: trimmed, and anything with spaces or control characters is refused without echoing it: %j",
  (bad) => {
    const dir = tempDir();
    expect(() => writeKey(bad, envFor(dir))).toThrow(
      /doesn't look like an API key/,
    );
    expect(() => writeKey(bad, envFor(dir))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(bad) }),
    );
    expect(() => resolveKey(envFor(dir, { CONCENTRATE_API_KEY: bad }))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(bad) }),
    );
  },
);

test("CN_CONFIG_HOME is resolved to an absolute path, and an existing directory keeps its mode", async () => {
  expect(path.isAbsolute(configDir({ CN_CONFIG_HOME: "relative/dir" }))).toBe(
    true,
  );
  expect(configDir({ CN_CONFIG_HOME: "~" })).toBe(homedir());
  const shared = tempDir();
  fs.chmodSync(shared, 0o755);
  writeKey("sk-1", envFor(shared));
  expect(fs.statSync(shared).mode & 0o777).toBe(0o755);
  expect(fs.statSync(path.join(shared, "credentials.json")).mode & 0o777).toBe(
    0o600,
  );
});
