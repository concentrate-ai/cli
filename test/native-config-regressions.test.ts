import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import { parseConfig, setConfig } from "../src/lib/config-formats.js";
import {
  applyNativeSetup,
  resetNativeSetup,
} from "../src/lib/native-config-store.js";
import { cursorConfigured, cursorDatabase } from "../src/lib/cursor-config.js";
import { configureTool, resetTool } from "../src/lib/tool-config.js";
import {
  readJson,
  writeKey,
  writePreferences,
  writeJson,
} from "../src/lib/settings.js";
import { tempDir, fakeTool } from "./helpers.js";
import { summarize } from "../src/lib/catalog.js";

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
  expect(result.preserved).toStrictEqual([]);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toStrictEqual({
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
  expect(fs.readFileSync(file, "utf8")).toBe(original);
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
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toStrictEqual({
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
  expect(result.preserved).toStrictEqual([file]);
  expect(fs.existsSync(state)).toBe(true);
  expect(readJson(state).files[0].original).toBe('{ "theme": "dark" }\n');
});

test.skipIf(process.getuid?.() === 0)(
  "a failed Configure keeps the credential helper executable",
  () => {
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
      expect(() => applyNativeSetup(state, plans("two"))).toThrow();
    } finally {
      fs.chmodSync(path.dirname(file), 0o700);
    }
    expect(fs.statSync(helper).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(helper, "utf8")).toBe("one");
  },
);

test.each([
  ["", "{"],
  ["\n", "{"],
  ["// note\n", "// note"],
  ["/* a */\n", "/* a */"],
])(
  "whitespace-only and comment-only JSON files are valid empty configurations: %j",
  (text, prefix) => {
    expect(parseConfig(text, "json")).toStrictEqual({});
    const written = setConfig(text, "json", ["model"], "x");
    expect(parseConfig(written, "json")).toStrictEqual({ model: "x" });
    expect(written.startsWith(prefix)).toBe(true);
  },
);

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
  fakeTool(bin, "opencode");
  writeKey("sk-regression", env);
  writePreferences(
    { claude: "small", codex: "small", opencode: "small", pi: "small" },
    env,
  );
  writeJson(path.join(env.CN_CONFIG_HOME, "catalog.json"), {
    version: 6,
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
  expect(fs.existsSync(keyFile)).toBe(true);
  const edited = JSON.parse(fs.readFileSync(settings, "utf8"));
  edited.theme = "tokyo";
  fs.writeFileSync(settings, JSON.stringify(edited));
  resetTool("opencode", env);
  expect(fs.existsSync(keyFile)).toBe(false);
  expect(JSON.parse(fs.readFileSync(settings, "utf8")).theme).toBe("tokyo");
});

test("an unreadable Cursor database does not make cursorConfigured throw", () => {
  const { env } = toolFixture();
  const database = cursorDatabase(env);
  fs.mkdirSync(path.dirname(database), { recursive: true });
  fs.writeFileSync(database, "not a sqlite database");
  expect(cursorConfigured(env)).toBe(false);
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
  expect(configured).toMatch(/# my codex config/);
  expect(configured).toMatch(/# providers I use/);
  expect(configured).toMatch(/model = "new"  # keep this note|model = "new"/);
  expect(parseConfig(configured, "toml").model_providers.cn.name).toStrictEqual(
    "CN",
  );
  // The user edits an unrelated setting, then Reset only undoes cn's changes.
  fs.writeFileSync(file, configured.replace('"trusted"', '"untrusted"'));
  resetNativeSetup(state, [file]);
  const restored = fs.readFileSync(file, "utf8");
  expect(restored).toMatch(/# my codex config/);
  expect(restored).toMatch(/# providers I use/);
  expect(restored).toMatch(/untrusted/);
  expect(
    JSON.parse(JSON.stringify(parseConfig(restored, "toml"))),
  ).toStrictEqual({
    model: "old",
    model_providers: { mine: { name: "Mine" } },
    projects: { x: { trust_level: "untrusted" } },
  });
});
