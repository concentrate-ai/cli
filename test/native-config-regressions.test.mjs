import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseConfig, setConfig } from "../dist/lib/config-formats.js";
import {
  applyNativeSetup,
  resetNativeSetup,
} from "../dist/lib/native-config-store.js";
import { cursorConfigured, cursorDatabase } from "../dist/lib/cursor-config.js";
import { configureTool, resetTool } from "../dist/lib/tool-config.js";
import { readJson, writeKey, writePreferences } from "../dist/lib/settings.js";
import { tempDir } from "./helpers.mjs";

const plan = (file, entries) => ({
  file,
  format: "json",
  changes: entries.map(([key, value]) => ({ key, value })),
});

test("configuring twice then resetting keeps edits made in between", () => {
  const dir = tempDir();
  const file = path.join(dir, "settings.json");
  const state = path.join(dir, "state", "restore.json");
  fs.writeFileSync(file, '{ "theme": "dark" }\n');
  applyNativeSetup(state, [plan(file, [[["model"], "a"]])]);
  const edited = JSON.parse(fs.readFileSync(file, "utf8"));
  edited.permissions = { allow: ["Bash(ls)"] };
  fs.writeFileSync(file, JSON.stringify(edited, null, 2));
  applyNativeSetup(state, [plan(file, [[["model"], "b"]])]);
  const result = resetNativeSetup(state, [file]);
  assert.deepEqual(result.preserved, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    theme: "dark",
    permissions: { allow: ["Bash(ls)"] },
  });
});

test("an untouched file still returns to its exact original bytes after reconfigure", () => {
  const dir = tempDir();
  const file = path.join(dir, "settings.json");
  const state = path.join(dir, "state", "restore.json");
  const original = '// mine\n{ "theme": "dark" }\n';
  fs.writeFileSync(file, original);
  applyNativeSetup(state, [plan(file, [[["model"], "a"]])]);
  applyNativeSetup(state, [plan(file, [[["model"], "b"]])]);
  resetNativeSetup(state, [file]);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("a setting an earlier Configure wrote stays tracked when the plan changes", () => {
  const dir = tempDir();
  const file = path.join(dir, "opencode.json");
  const state = path.join(dir, "state", "restore.json");
  fs.writeFileSync(file, "{}\n");
  applyNativeSetup(state, [
    plan(file, [[["provider", "concentrate"], { a: 1 }]]),
  ]);
  applyNativeSetup(state, [
    plan(file, [[["providers", "concentrate"], { b: 2 }]]),
  ]);
  const edited = JSON.parse(fs.readFileSync(file, "utf8"));
  edited.theme = "light";
  fs.writeFileSync(file, JSON.stringify(edited));
  resetNativeSetup(state, [file]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    theme: "light",
  });
});

test("Reset keeps the restore record when the user deleted a configured file", () => {
  const dir = tempDir();
  const file = path.join(dir, "settings.json");
  const state = path.join(dir, "state", "restore.json");
  fs.writeFileSync(file, '{ "theme": "dark" }\n');
  applyNativeSetup(state, [plan(file, [[["model"], "a"]])]);
  fs.rmSync(file);
  const result = resetNativeSetup(state, [file]);
  assert.deepEqual(result.preserved, [file]);
  assert.ok(fs.existsSync(state));
  assert.equal(readJson(state).files[0].original, '{ "theme": "dark" }\n');
});

test("a failed Configure keeps the credential helper executable", (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores directory modes");
  const dir = tempDir();
  const helper = path.join(dir, "state", "credential-helper");
  const file = path.join(dir, "locked", "settings.json");
  const state = path.join(dir, "state", "restore.json");
  fs.mkdirSync(path.dirname(file));
  const plans = (value) => [
    {
      file: helper,
      format: "text",
      mode: 0o700,
      changes: [{ key: ["content"], value }],
    },
    plan(file, [[["model"], value]]),
  ];
  applyNativeSetup(state, plans("one"));
  fs.chmodSync(path.dirname(file), 0o500);
  try {
    assert.throws(() => applyNativeSetup(state, plans("two")));
  } finally {
    fs.chmodSync(path.dirname(file), 0o700);
  }
  assert.equal(fs.statSync(helper).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(helper, "utf8"), "one");
});

test("whitespace-only and comment-only JSON files are valid empty configurations", () => {
  for (const text of ["", "\n", "// note\n", "/* a */\n"]) {
    assert.deepEqual(parseConfig(text, "json"), {});
    const written = setConfig(text, "json", ["model"], "x");
    assert.deepEqual(parseConfig(written, "json"), { model: "x" });
    assert.ok(written.startsWith(text.trim() ? text.trimEnd() : "{"));
  }
});

function toolFixture() {
  const dir = tempDir("cn-reg-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const env = {
    HOME: dir,
    CN_CONFIG_HOME: path.join(dir, "cn"),
    CN_OFFLINE: "1",
    PATH: `${bin}:${path.dirname(process.execPath)}`,
    XDG_CONFIG_HOME: path.join(dir, "config"),
  };
  return { dir, bin, env };
}

test("Logout/Reset removes OpenCode's key file even if an unrelated setting was edited", async () => {
  const { bin, env } = toolFixture();
  const { fakeTool } = await import("./helpers.mjs");
  const { summarize } = await import("../dist/lib/catalog.js");
  const { writeJson } = await import("../dist/lib/settings.js");
  fakeTool(bin, "opencode");
  writeKey("sk-regression", env);
  writePreferences(
    { claude: "small", codex: "small", opencode: "small", pi: "small" },
    env,
  );
  writeJson(path.join(env.CN_CONFIG_HOME, "catalog.json"), {
    version: 3,
    models: [
      summarize({
        id: "small",
        name: "small",
        context_window: 32768,
        max_tokens: 4096,
        integrations: {
          claude_code: { supported: true },
          codex: { supported: true },
        },
        providers: {
          a: {
            context_window: 32768,
            max_output_tokens: 4096,
            supports: {
              input: { text: true },
              tools: { function_calling: true },
            },
          },
        },
      }),
    ],
  });
  await configureTool("opencode", env);
  const settings = path.join(env.XDG_CONFIG_HOME, "opencode", "opencode.json");
  const keyFile = path.join(
    env.CN_CONFIG_HOME,
    "tool-setups",
    "opencode",
    "api-key",
  );
  assert.ok(fs.existsSync(keyFile));
  const edited = JSON.parse(fs.readFileSync(settings, "utf8"));
  edited.theme = "tokyo";
  fs.writeFileSync(settings, JSON.stringify(edited));
  resetTool("opencode", env);
  assert.equal(fs.existsSync(keyFile), false);
  assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).theme, "tokyo");
});

test("an unreadable Cursor database does not make cursorConfigured throw", () => {
  const { env } = toolFixture();
  const database = cursorDatabase(env);
  fs.mkdirSync(path.dirname(database), { recursive: true });
  fs.writeFileSync(database, "not a sqlite database");
  assert.equal(cursorConfigured(env), false);
});

test("TOML edits keep comments and unrelated layout, through Configure and an edited Reset", () => {
  const dir = tempDir();
  const file = path.join(dir, "config.toml");
  const state = path.join(dir, "state", "restore.json");
  const original = [
    "# my codex config",
    'model = "old"  # keep this note',
    "",
    "# providers I use",
    "[model_providers.mine]",
    'name = "Mine"',
    "",
    "[projects.x]",
    'trust_level = "trusted"',
    "",
  ].join("\n");
  fs.writeFileSync(file, original);
  const toml = (entries) => ({
    file,
    format: "toml",
    changes: entries.map(([key, value]) => ({ key, value })),
  });
  applyNativeSetup(state, [
    toml([
      [["model_provider"], "cn"],
      [["model"], "new"],
      [
        ["model_providers", "cn"],
        { name: "CN", auth: { command: "x", args: [] } },
      ],
    ]),
  ]);
  const configured = fs.readFileSync(file, "utf8");
  assert.match(configured, /# my codex config/);
  assert.match(configured, /# providers I use/);
  assert.match(configured, /model = "new"  # keep this note|model = "new"/);
  assert.deepEqual(
    parseConfig(configured, "toml").model_providers.cn.name,
    "CN",
  );
  // The user edits an unrelated setting, then Reset only undoes cn's changes.
  fs.writeFileSync(file, configured.replace('"trusted"', '"untrusted"'));
  resetNativeSetup(state, [file]);
  const restored = fs.readFileSync(file, "utf8");
  assert.match(restored, /# my codex config/);
  assert.match(restored, /# providers I use/);
  assert.match(restored, /untrusted/);
  assert.deepEqual(JSON.parse(JSON.stringify(parseConfig(restored, "toml"))), {
    model: "old",
    model_providers: { mine: { name: "Mine" } },
    projects: { x: { trust_level: "untrusted" } },
  });
});
