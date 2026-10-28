import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseHarnessLaunchArgs } from "../dist/lib/cli.js";
import { codexSessions, resolveSessionArgs } from "../dist/lib/sessions.js";
import { getHarness } from "../dist/lib/harnesses/registry.js";
import { runCn, tempDir } from "./helpers.mjs";

function rig() {
  const root = tempDir("cn-resume-test-");
  return {
    root,
    env: {
      HOME: root,
      CODEX_HOME: path.join(root, "codex"),
      PI_CODING_AGENT_DIR: path.join(root, "pi"),
      CN_CONFIG_HOME: path.join(root, "cn"),
      PATH: path.dirname(process.execPath),
      CONCENTRATE_API_KEY: "sk-test",
      CN_OFFLINE: "1",
    },
  };
}
function save(file, entry, age = 0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(entry) + "\nHISTORY_MUST_STAY_INTACT\n",
  );
  const time = new Date(Date.now() - age);
  fs.utimesSync(file, time, time);
  return file;
}
function codex(
  env,
  id,
  { cwd = process.cwd(), provider = "openai", age = 0 } = {},
) {
  return save(
    path.join(env.CODEX_HOME, "sessions", "2026", "10", "27", `${id}.jsonl`),
    { type: "session_meta", payload: { id, cwd, model_provider: provider } },
    age,
  );
}
function pi(
  env,
  id,
  { legacy = false, cwd = process.cwd(), age = 0, directory } = {},
) {
  return save(
    path.join(
      directory ||
        (legacy
          ? path.join(env.CN_CONFIG_HOME, "pi-sessions")
          : path.join(env.PI_CODING_AGENT_DIR, "sessions", "--project--")),
      `${id}.jsonl`,
    ),
    { type: "session", version: 3, id, cwd },
    age,
  );
}

test("resume and continue have consistent aliases for every CLI; -- preserves native input", () => {
  const expected = {
    claude: [["--resume", "id"], ["--resume"], ["--continue"]],
    codex: [["resume", "id"], ["resume"], ["resume", "--last"]],
    opencode: [["--session", "id"], null, ["--continue"]],
    pi: [["--session", "id"], ["--resume"], ["--continue"]],
  };
  for (const [target, cases] of Object.entries(expected)) {
    for (const [index, args] of [
      ["resume", "id"],
      ["resume"],
      ["continue"],
    ].entries())
      if (cases[index] === null)
        assert.throws(() => parseHarnessLaunchArgs(target, args), /--session/);
      else
        assert.deepEqual(
          parseHarnessLaunchArgs(target, args).forwarded,
          cases[index],
        );
    assert.deepEqual(
      parseHarnessLaunchArgs(target, ["--", "continue"]).forwarded,
      ["continue"],
    );
    assert.equal(
      parseHarnessLaunchArgs(target, ["--model", "chosen", "resume", "id"])
        .model,
      "chosen",
    );
  }
});

test("Codex discovery includes subscription/provider sessions and restricts continue to the current project", async () => {
  const { env, root } = rig();
  const original = codex(env, "subscription", { age: 1000 });
  codex(env, "concentrate", { provider: "concentrate", age: 2000 });
  codex(env, "other-project", { cwd: root });
  fs.writeFileSync(
    path.join(path.dirname(original), "broken.jsonl"),
    "invalid",
  );
  fs.symlinkSync(original, path.join(path.dirname(original), "link.jsonl"));
  assert.deepEqual(
    codexSessions(env).map((s) => s.id),
    ["subscription", "concentrate"],
  );
  const before = fs.readFileSync(original, "utf8");
  assert.deepEqual(
    await resolveSessionArgs("codex", "unused", ["resume", "--last"], env),
    ["resume", "subscription"],
  );
  assert.deepEqual(
    await resolveSessionArgs(
      "codex",
      "unused",
      ["exec", "resume", "--last", "Continue work"],
      env,
    ),
    ["exec", "resume", "subscription", "Continue work"],
  );
  assert.deepEqual(
    await resolveSessionArgs(
      "codex",
      "unused",
      ["resume", "--last", "--all"],
      env,
    ),
    ["resume", "other-project", "--all"],
  );
  assert.equal(fs.readFileSync(original, "utf8"), before);
});

test("Codex resume fails when there are no local sessions", async () => {
  const { env } = rig();
  await assert.rejects(
    resolveSessionArgs("codex", "unused", ["resume", "--last"], env),
    /No saved/,
  );
  codex(env, "saved");
  await assert.rejects(
    resolveSessionArgs("codex", "unused", ["resume"], env),
    /Choose a session/,
  );
});

test("Pi handles resume and session paths itself", async () => {
  const { env } = rig();
  for (const args of [
    ["--continue"],
    ["--resume"],
    ["--session", "partial-id"],
    ["--session", "/some/old/session.jsonl"],
    ["--session-dir", "/custom", "--resume"],
  ])
    assert.deepEqual(await resolveSessionArgs("pi", "unused", args, env), args);
});

test("OpenCode explicit native session arguments do not invoke a cn picker", async () => {
  const { env } = rig();
  for (const args of [
    [],
    ["--session", "ses_existing"],
    ["run", "--session", "ses_existing", "hello"],
  ])
    assert.deepEqual(
      await resolveSessionArgs("opencode", "nonexistent", args, env),
      args,
    );
});

function openCodeRig() {
  const { root, env } = rig();
  const executable = path.join(root, "opencode");
  const calls = path.join(root, "calls.jsonl");
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs"); const args = process.argv.slice(2);
if(args[0] === "--help") { console.log("--standalone"); process.exit(0); }
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args, config: process.env.OPENCODE_CONFIG_CONTENT})+"\\n");
if(args[0] === "session") console.log(JSON.stringify([{id:"ses_existing",title:"Saved conversation",directory:process.cwd(),updated:1}]));
if(args[0] === "api" && args.some(arg => arg.includes("ses_new"))) { console.error("HTTP 404 not found"); process.exit(1); }
if(args[0] === "api" && (process.env.FAIL_SWITCH || args.some(arg => arg.includes("ses_missing")))) process.exit(1);
`,
    { mode: 0o755 },
  );
  env.PATH = `${root}:${env.PATH}`;
  return {
    env,
    executable,
    calls: () =>
      fs.readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse),
  };
}

test("OpenCode resume validates the session and switches its durable provider before launching", () => {
  const rig = openCodeRig();
  const result = runCn(
    ["opencode", "--model", "chosen", "resume", "ses_existing"],
    { env: rig.env },
  );
  assert.equal(result.status, 0, result.stderr);
  const calls = rig.calls();
  const switchCall = calls.find((call) => call.args[0] === "api");
  assert.ok(switchCall);
  assert.deepEqual(JSON.parse(switchCall.args.at(-1)), {
    model: { providerID: "concentrate", id: "chosen" },
  });
  assert.deepEqual(calls.at(-1).args, [
    "--standalone",
    "--session",
    "ses_existing",
  ]);
  assert.equal(JSON.parse(calls.at(-1).config).model, "concentrate/chosen");
  assert.ok(
    !JSON.stringify(calls).includes("sk-test"),
    "key must not be placed in argv or inline config",
  );
});

test("OpenCode stops on a missing session or failed provider switch instead of using the previous connection", () => {
  const rig = openCodeRig();
  const missing = runCn(["opencode", "resume", "ses_missing"], {
    env: rig.env,
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Could not switch/);
  assert.ok(!rig.calls().some((call) => call.args[0] === "--standalone"));
  const failed = runCn(["opencode", "continue"], {
    env: { ...rig.env, FAIL_SWITCH: "1" },
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Could not switch/);
  assert.ok(!rig.calls().some((call) => call.args[0] === "--standalone"));
});

test("OpenCode keeps --session after a subcommand and creates new named sessions", () => {
  const rig = openCodeRig();
  for (const args of [
    ["--", "run", "--session", "ses_existing", "hello"],
    ["--", "run", "--continue", "hello"],
  ]) {
    const result = runCn(["opencode", ...args], { env: rig.env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(rig.calls().at(-1).args, [
      "run",
      "--standalone",
      "--session",
      "ses_existing",
      "hello",
    ]);
  }
  // `--session <new id>` creates the session: a 404 from the switch is not an error.
  const created = runCn(["opencode", "--", "--session", "ses_new"], {
    env: rig.env,
  });
  assert.equal(created.status, 0, created.stderr);
  assert.deepEqual(rig.calls().at(-1).args, [
    "--standalone",
    "--session",
    "ses_new",
  ]);
});

test("Codex continue and the picker skip subagent and scripted sessions unless asked", async () => {
  const { env } = rig();
  const meta = (id, source) => ({
    type: "session_meta",
    payload: { id, cwd: process.cwd(), source },
  });
  const file = (id) =>
    path.join(env.CODEX_HOME, "sessions", "2026", "10", "27", `${id}.jsonl`);
  save(file("interactive"), meta("interactive", "cli"), 3000);
  save(
    file("subagent"),
    meta("subagent", { subagent: { other: "guardian" } }),
    0,
  );
  save(file("scripted"), meta("scripted", "exec"), 1000);
  assert.deepEqual(
    codexSessions(env).map((s) => s.id),
    ["interactive"],
  );
  assert.deepEqual(
    await resolveSessionArgs("codex", "unused", ["resume", "--last"], env),
    ["resume", "interactive"],
  );
  assert.deepEqual(
    codexSessions(env, process.cwd(), {
      includeNonInteractive: true,
    }).map((s) => s.id),
    ["subagent", "scripted", "interactive"],
  );
  assert.deepEqual(
    await resolveSessionArgs(
      "codex",
      "unused",
      ["resume", "--last", "--include-non-interactive"],
      env,
    ),
    ["resume", "subagent", "--include-non-interactive"],
  );
});

test("a session whose header line is larger than 64 KiB is still found", () => {
  const { env } = rig();
  save(path.join(env.CODEX_HOME, "sessions", "2026", "10", "27", "big.jsonl"), {
    type: "session_meta",
    payload: {
      id: "big",
      cwd: process.cwd(),
      source: "cli",
      instructions: "x".repeat(200000),
    },
  });
  assert.deepEqual(
    codexSessions(env).map((s) => s.id),
    ["big"],
  );
});

test("codex exec resume --last continues scripted runs and never forwards the picker-only flag", async () => {
  const { env } = rig();
  const file = (id) =>
    path.join(env.CODEX_HOME, "sessions", "2026", "10", "27", `${id}.jsonl`);
  const meta = (id, source) => ({
    type: "session_meta",
    payload: { id, cwd: process.cwd(), source },
  });
  save(file("scripted"), meta("scripted", "exec"), 0);
  save(file("subagent"), meta("subagent", { subagent: { other: "x" } }), 10000);
  for (const extra of [[], ["--include-non-interactive"]])
    assert.deepEqual(
      await resolveSessionArgs(
        "codex",
        "unused",
        ["exec", "resume", "--last", ...extra, "go"],
        env,
      ),
      ["exec", "resume", "scripted", "go"],
    );
});
