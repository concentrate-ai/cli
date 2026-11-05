import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect, onTestFinished } from "vitest";
import { prepareClaudeContext } from "../../dist/lib/claude/claude-context.js";
import claude from "../../dist/lib/harnesses/claude.js";
import {
  outputLimit,
  supportedEffort,
} from "../../dist/lib/claude/claude-context/register.mjs";
import { tempDir } from "../helpers.js";

const available = [
  { id: "custom-small", context: 128000 },
  { id: "custom-large", context: 400000 },
  { id: "provider/custom-small", context: 100000 },
  { id: "claude-sonnet-4-6", context: 1000000 },
  { id: "missing" },
];

async function rig(t, options = {}) {
  const plugin = prepareClaudeContext({ available, ...options });
  onTestFinished(plugin.cleanup);
  const { register } = await import(
    pathToFileURL(path.join(plugin.directory, "hooks/register.mjs"))
  );
  const hooks = new Map();
  register((name, fn) => {
    hooks.set(name, fn);
    return {
      catch(handler) {
        hooks.set(`${name}:catch`, handler);
      },
    };
  });
  let model = "custom-large";
  const values = new Map([["CLAUDE_CODE_MAX_CONTEXT_TOKENS", "400000"]]);
  const $ = {
    session: { model: async () => model },
    env: {
      get: async (name) => values.get(name),
      set: async (name, next) => values.set(name, next),
    },
  };
  return {
    hooks,
    $,
    setModel: (next) => {
      model = next;
    },
    value: () => values.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS"),
    plugin,
  };
}

test("switching large → small → native → custom updates and clears the same process limit", async (t) => {
  const r = await rig(t);
  const switchTo = async (model) => {
    r.setModel(model);
    await r.hooks.get("classic.PostModelSwitch")(
      r.$,
      { to_model: "a-stale-switch" },
      async () => ({}),
    );
    return r.value();
  };
  expect(await switchTo("custom-large"), "custom-large").toBe("400000");
  expect(await switchTo("custom-small"), "custom-small").toBe("128000");
  expect(await switchTo("claude-sonnet-4-6"), "claude-sonnet-4-6").toBe(
    undefined,
  );
  expect(await switchTo("provider/custom-small"), "provider/custom-small").toBe(
    "100000",
  );
  expect(await switchTo("other/custom-large"), "other/custom-large").toBe(
    "400000",
  );
  expect(await switchTo("missing"), "missing").toBe(undefined);
});

test("prompt gate corrects stale limits before next and stops prompts when synchronization fails", async (t) => {
  const r = await rig(t);
  r.setModel("custom-small");
  await r.hooks.get("prompt.submit")(r.$, {}, async () => {
    expect(r.value()).toBe("128000");
  });
  r.$.env.set = async () => {
    throw new Error("denied");
  };
  r.setModel("custom-large");
  await expect(
    r.hooks.get("prompt.submit")(r.$, {}, () => expect.fail("must not send")),
  ).rejects.toThrow(/denied/);
  expect((await r.hooks.get("prompt.submit:catch")()).drop).toMatch(
    /could not update/,
  );
});

test("commands use the actual selected model and denied or failed switches leave its limit intact", async (t) => {
  const r = await rig(t);
  const command = r.hooks.get("command.run");
  await command(r.$, {}, async () => {
    r.setModel("custom-small");
    return { text: "switched" };
  });
  expect(r.value()).toBe("128000");
  const result = await command(r.$, {}, async () => ({ text: "denied" }));
  expect(result.text).toBe("denied");
  expect(r.value()).toBe("128000");
  await expect(
    command(r.$, {}, async () => {
      throw new Error("cancelled");
    }),
  ).rejects.toThrow(/cancelled/);
  expect(r.value()).toBe("128000");
  r.setModel("custom-large");
  await command(r.$, {}, async () => {
    expect(r.value(), "/context and /compact read the current window").toBe(
      "400000",
    );
  });
});

test("temporary plugin contains only model metadata and is removed on cleanup", async (t) => {
  const r = await rig(t);
  const text = fs.readFileSync(
    path.join(r.plugin.directory, "hooks/limits.mjs"),
    "utf8",
  );
  expect(text).toMatch(/custom-small/);
  expect(text).not.toMatch(/undefined|apiKey|sk-/);
  r.plugin.cleanup();
  expect(fs.existsSync(r.plugin.directory)).toBe(false);
});

test("explicit context override stays fixed while the plugin manages other capabilities", async () => {
  const home = tempDir("cn-context-home-");
  const prepared = await claude.prepare({
    model: "custom-small",
    key: "sk-test",
    available,
    forwarded: [],
    env: {
      HOME: home,
      CN_CONFIG_HOME: path.join(home, "cn"),
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "100000",
    },
  });
  expect(prepared.args).toContain("--plugin-dir");
  expect(
    JSON.parse(prepared.args[prepared.args.indexOf("--settings") + 1])
      .enabledPlugins["cn-context@concentrate-cn"],
  ).toBe(false);
  const data = await import(
    pathToFileURL(
      path.join(
        prepared.args[prepared.args.indexOf("--plugin-dir") + 1],
        "hooks/limits.mjs",
      ),
    )
  );
  expect(data.preferences.fixedContext).toBe(true);
  expect(prepared.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("100000");
  expect(JSON.parse(prepared.args[1]).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(
    "100000",
  );
  prepared.cleanup();
});

test.each(["--bare", "--safe-mode"])(
  "modes that disable the synchronization plugin are refused with an actionable message: %s",
  (flag) => {
    expect(() =>
      prepareClaudeContext({ available, forwarded: [flag] }),
    ).toThrow(/Remove --bare or --safe-mode/);
  },
);

test("output budgets respect model caps without raising Claude's default request size", async () => {
  expect(outputLimit(4096)).toBe("4096");
  expect(outputLimit(128000)).toBe("32000");
  expect(outputLimit(4096, "64000")).toBe("4096");
  expect(outputLimit(128000, "64_000")).toBe("64000");
  expect(outputLimit(null, "64000")).toBe("64000");
  expect(outputLimit(null)).toBe(undefined);
});

test("effort is clamped to supported named levels and unknown metadata leaves it alone", async () => {
  expect(supportedEffort("max", ["low", "medium"])).toBe("medium");
  expect(supportedEffort("low", ["high"])).toBe("high");
  expect(supportedEffort("medium", ["low", "medium", "high"])).toBe("medium");
  expect(supportedEffort("max", null)).toBe("max");
  expect(supportedEffort("max", ["none"])).toBe("max");
});

test("output and thinking overrides follow custom models and restore on native Claude", async () => {
  const plugin = prepareClaudeContext({
    available: [
      {
        id: "no-thinking",
        output: 4096,
        reasoningSupport: false,
        efforts: ["none"],
      },
      {
        id: "thinking",
        output: 64000,
        reasoningSupport: true,
        efforts: ["low", "medium"],
      },
    ],
  });
  onTestFinished(plugin.cleanup);
  const { register } = await import(
    pathToFileURL(path.join(plugin.directory, "hooks/register.mjs"))
  );
  const hooks = new Map();
  register((name, fn) => {
    hooks.set(name, fn);
    return { catch() {} };
  });
  let model = "no-thinking";
  const values = new Map();
  const $ = {
    session: { model: async () => model },
    env: {
      get: async (name) => values.get(name),
      set: async (name, value) => values.set(name, value),
    },
  };
  await hooks.get("session.start")($, {}, async () => ({}));
  expect(values.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS")).toBe("4096");
  expect(values.get("CLAUDE_CODE_DISABLE_THINKING")).toBe("1");
  model = "thinking";
  await hooks.get("prompt.submit")($, {}, async () => ({}));
  expect(values.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS")).toBe("32000");
  expect(values.get("CLAUDE_CODE_DISABLE_THINKING")).toBe(undefined);
  const requests = [];
  const next = async function* (event) {
    requests.push(event);
  };
  await Array.fromAsync(
    hooks.get("turn.step")($, { model, effort: "max" }, next),
  );
  expect(requests[0].effort).toBe("medium");
  model = "claude-sonnet-4-6";
  await hooks.get("classic.PostModelSwitch")($, {}, async () => ({}));
  expect(values.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS")).toBe(undefined);
  expect(values.get("CLAUDE_CODE_DISABLE_THINKING")).toBe(undefined);
});

test("a permanent mod reads explicit preferences when the session starts", async (t) => {
  const r = await rig(t, { persistent: true });
  await r.$.env.set("CLAUDE_CODE_MAX_CONTEXT_TOKENS", "90000");
  await r.$.env.set("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "2000");
  await r.hooks.get("session.start")(r.$, {}, async () => ({}));
  r.setModel("custom-small");
  await r.hooks.get("classic.PostModelSwitch")(r.$, {}, async () => ({}));
  expect(r.value()).toBe("90000");
  expect(await r.$.env.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS")).toBe("2000");
});
