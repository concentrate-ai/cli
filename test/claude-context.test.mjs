import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { prepareClaudeContext } from "../dist/lib/claude-context.js";
import claude from "../dist/lib/harnesses/claude.js";

const available = [
  { id: "custom-small", context: 128000 },
  { id: "custom-large", context: 400000 },
  { id: "provider/custom-small", context: 100000 },
  { id: "claude-sonnet-4-6", context: 1000000 },
  { id: "missing" },
];

async function rig(t, options = {}) {
  const plugin = prepareClaudeContext({ available, ...options });
  t.after(plugin.cleanup);
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
  for (const [model, value] of [
    ["custom-large", "400000"],
    ["custom-small", "128000"],
    ["claude-sonnet-4-6", undefined],
    ["provider/custom-small", "100000"],
    ["other/custom-large", "400000"],
    ["missing", undefined],
  ]) {
    r.setModel(model);
    await r.hooks.get("classic.PostModelSwitch")(
      r.$,
      { to_model: "a-stale-switch" },
      async () => ({}),
    );
    assert.equal(r.value(), value, model);
  }
});

test("prompt gate corrects stale limits before next and stops prompts when synchronization fails", async (t) => {
  const r = await rig(t);
  r.setModel("custom-small");
  await r.hooks.get("prompt.submit")(r.$, {}, async () => {
    assert.equal(r.value(), "128000");
  });
  r.$.env.set = async () => {
    throw new Error("denied");
  };
  r.setModel("custom-large");
  await assert.rejects(
    r.hooks.get("prompt.submit")(r.$, {}, () => assert.fail("must not send")),
    /denied/,
  );
  assert.match(
    (await r.hooks.get("prompt.submit:catch")()).drop,
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
  assert.equal(r.value(), "128000");
  const result = await command(r.$, {}, async () => ({ text: "denied" }));
  assert.equal(result.text, "denied");
  assert.equal(r.value(), "128000");
  await assert.rejects(
    command(r.$, {}, async () => {
      throw new Error("cancelled");
    }),
    /cancelled/,
  );
  assert.equal(r.value(), "128000");
  r.setModel("custom-large");
  await command(r.$, {}, async () => {
    assert.equal(
      r.value(),
      "400000",
      "/context and /compact read the current window",
    );
  });
});

test("temporary plugin contains only model metadata and is removed on cleanup", async (t) => {
  const r = await rig(t);
  const text = fs.readFileSync(
    path.join(r.plugin.directory, "hooks/limits.mjs"),
    "utf8",
  );
  assert.match(text, /custom-small/);
  assert.doesNotMatch(text, /undefined|apiKey|sk-/);
  r.plugin.cleanup();
  assert.equal(fs.existsSync(r.plugin.directory), false);
});

test("explicit context override stays fixed while the plugin manages other capabilities", async () => {
  const prepared = await claude.prepare({
    model: "custom-small",
    key: "sk-test",
    available,
    forwarded: [],
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "100000" },
  });
  assert.ok(prepared.args.includes("--plugin-dir"));
  assert.equal(
    JSON.parse(prepared.args[prepared.args.indexOf("--settings") + 1])
      .enabledPlugins["cn-context@concentrate-cn"],
    false,
  );
  const data = await import(
    pathToFileURL(
      path.join(
        prepared.args[prepared.args.indexOf("--plugin-dir") + 1],
        "hooks/limits.mjs",
      ),
    )
  );
  assert.equal(data.preferences.fixedContext, true);
  assert.equal(prepared.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "100000");
  assert.equal(
    JSON.parse(prepared.args[1]).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
    "100000",
  );
  prepared.cleanup();
});

test("modes that disable the synchronization plugin are refused with an actionable message", () => {
  for (const flag of ["--bare", "--safe-mode"]) {
    assert.throws(
      () => prepareClaudeContext({ available, forwarded: [flag] }),
      /Remove --bare or --safe-mode/,
    );
  }
});

test("output budgets respect model caps without raising Claude's default request size", async () => {
  const { outputLimit } =
    await import("../dist/lib/claude-context/register.mjs");
  assert.equal(outputLimit(4096), "4096");
  assert.equal(outputLimit(128000), "32000");
  assert.equal(outputLimit(4096, "64000"), "4096");
  assert.equal(outputLimit(128000, "64_000"), "64000");
  assert.equal(outputLimit(null, "64000"), "64000");
  assert.equal(outputLimit(null), undefined);
});

test("effort is clamped to supported named levels and unknown metadata leaves it alone", async () => {
  const { supportedEffort } =
    await import("../dist/lib/claude-context/register.mjs");
  assert.equal(supportedEffort("max", ["low", "medium"]), "medium");
  assert.equal(supportedEffort("low", ["high"]), "high");
  assert.equal(supportedEffort("medium", ["low", "medium", "high"]), "medium");
  assert.equal(supportedEffort("max", null), "max");
  assert.equal(supportedEffort("max", ["none"]), "max");
});

test("output and thinking overrides follow custom models and restore on native Claude", async (t) => {
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
  t.after(plugin.cleanup);
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
  assert.equal(values.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS"), "4096");
  assert.equal(values.get("CLAUDE_CODE_DISABLE_THINKING"), "1");
  model = "thinking";
  await hooks.get("prompt.submit")($, {}, async () => ({}));
  assert.equal(values.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS"), "32000");
  assert.equal(values.get("CLAUDE_CODE_DISABLE_THINKING"), undefined);
  const requests = [];
  const next = async function* (event) {
    requests.push(event);
  };
  for await (const item of hooks.get("turn.step")(
    $,
    { model, effort: "max" },
    next,
  )) {
  }
  assert.equal(requests[0].effort, "medium");
  model = "claude-sonnet-4-6";
  await hooks.get("classic.PostModelSwitch")($, {}, async () => ({}));
  assert.equal(values.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS"), undefined);
  assert.equal(values.get("CLAUDE_CODE_DISABLE_THINKING"), undefined);
});

test("a permanent mod reads explicit preferences when the session starts", async (t) => {
  const r = await rig(t, { persistent: true });
  await r.$.env.set("CLAUDE_CODE_MAX_CONTEXT_TOKENS", "90000");
  await r.$.env.set("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "2000");
  await r.hooks.get("session.start")(r.$, {}, async () => ({}));
  r.setModel("custom-small");
  await r.hooks.get("classic.PostModelSwitch")(r.$, {}, async () => ({}));
  assert.equal(r.value(), "90000");
  assert.equal(await r.$.env.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS"), "2000");
});
