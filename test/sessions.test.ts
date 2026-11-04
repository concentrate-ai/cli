import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import { parseHarnessLaunchArgs } from "../src/lib/cli/cli.js";
import { codexSessions, resolveSessionArgs } from "../src/lib/sessions.js";
import { runCn, tempDir } from "./helpers.js";

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
test.each([
  ["claude", ["resume", "id"], ["--resume", "id"]],
  ["claude", ["resume"], ["--resume"]],
  ["claude", ["continue"], ["--continue"]],
  ["codex", ["resume", "id"], ["resume", "id"]],
  ["codex", ["resume"], ["resume"]],
  ["codex", ["continue"], ["resume", "--last"]],
  ["opencode", ["resume", "id"], ["--session", "id"]],
  ["opencode", ["continue"], ["--continue"]],
  ["pi", ["resume", "id"], ["--session", "id"]],
  ["pi", ["resume"], ["--resume"]],
  ["pi", ["continue"], ["--continue"]],
])(
  "resume and continue have consistent aliases for every CLI; -- preserves native input: %s %j",
  (target, args, forwarded) => {
    expect(parseHarnessLaunchArgs(target, args).forwarded).toStrictEqual(
      forwarded,
    );
  },
);

test("resume and continue have consistent aliases for every CLI; -- preserves native input: opencode resume without an id", () => {
  expect(() => parseHarnessLaunchArgs("opencode", ["resume"])).toThrow(
    /--session/,
  );
});

test.each(["claude", "codex", "opencode", "pi"])(
  "resume and continue have consistent aliases for every CLI; -- preserves native input: %s -- and --model",
  (target) => {
    expect(
      parseHarnessLaunchArgs(target, ["--", "continue"]).forwarded,
    ).toStrictEqual(["continue"]);
    expect(
      parseHarnessLaunchArgs(target, ["--model", "chosen", "resume", "id"])
        .model,
    ).toBe("chosen");
  },
);

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
  expect(codexSessions(env)).toMatchObject([
    { id: "subscription" },
    { id: "concentrate" },
  ]);
  const before = fs.readFileSync(original, "utf8");
  expect(
    await resolveSessionArgs("codex", "unused", ["resume", "--last"], env),
  ).toStrictEqual(["resume", "subscription"]);
  expect(
    await resolveSessionArgs(
      "codex",
      "unused",
      ["exec", "resume", "--last", "Continue work"],
      env,
    ),
  ).toStrictEqual(["exec", "resume", "subscription", "Continue work"]);
  expect(
    await resolveSessionArgs(
      "codex",
      "unused",
      ["resume", "--last", "--all"],
      env,
    ),
  ).toStrictEqual(["resume", "other-project", "--all"]);
  expect(fs.readFileSync(original, "utf8")).toBe(before);
});

test("Codex resume fails when there are no local sessions", async () => {
  const { env } = rig();
  await expect(
    resolveSessionArgs("codex", "unused", ["resume", "--last"], env),
  ).rejects.toThrow(/No saved/);
  codex(env, "saved");
  await expect(
    resolveSessionArgs("codex", "unused", ["resume"], env),
  ).rejects.toThrow(/Choose a session/);
});

test.each([
  [["--continue"]],
  [["--resume"]],
  [["--session", "partial-id"]],
  [["--session", "/some/old/session.jsonl"]],
  [["--session-dir", "/custom", "--resume"]],
])("Pi handles resume and session paths itself: %j", async (args) => {
  const { env } = rig();
  expect(await resolveSessionArgs("pi", "unused", args, env)).toStrictEqual(
    args,
  );
});

test.each([
  [[]],
  [["--session", "ses_existing"]],
  [["run", "--session", "ses_existing", "hello"]],
])(
  "OpenCode explicit native session arguments do not invoke a cn picker: %j",
  async (args) => {
    const { env } = rig();
    expect(
      await resolveSessionArgs("opencode", "nonexistent", args, env),
    ).toStrictEqual(args);
  },
);

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
  expect(result.status, result.stderr).toBe(0);
  const calls = rig.calls();
  expect(calls[0].args[0]).toBe("api");
  expect(JSON.parse(calls[0].args.at(-1))).toStrictEqual({
    model: { providerID: "concentrate", id: "chosen" },
  });
  expect(calls.at(-1).args).toStrictEqual([
    "--standalone",
    "--session",
    "ses_existing",
  ]);
  expect(JSON.parse(calls.at(-1).config).model).toBe("concentrate/chosen");
  expect(
    JSON.stringify(calls),
    "key must not be placed in argv or inline config",
  ).not.toContain("sk-test");
});

test("OpenCode stops on a missing session or failed provider switch instead of using the previous connection", () => {
  const rig = openCodeRig();
  const missing = runCn(["opencode", "resume", "ses_missing"], {
    env: rig.env,
  });
  expect(missing.status).toBe(1);
  expect(missing.stderr).toMatch(/Could not switch/);
  const afterMissing = rig.calls();
  expect(afterMissing).toHaveLength(1);
  expect(afterMissing[0].args[0]).toBe("api");
  const failed = runCn(["opencode", "continue"], {
    env: { ...rig.env, FAIL_SWITCH: "1" },
  });
  expect(failed.status).toBe(1);
  expect(failed.stderr).toMatch(/Could not switch/);
  const afterFailed = rig.calls();
  expect(afterFailed).toHaveLength(3);
  expect(afterFailed[0].args[0]).toBe("api");
  expect(afterFailed[1].args[0]).toBe("session");
  expect(afterFailed[2].args[0]).toBe("api");
});

test.each([
  [["--", "run", "--session", "ses_existing", "hello"]],
  [["--", "run", "--continue", "hello"]],
])(
  "OpenCode keeps --session after a subcommand and creates new named sessions: %j",
  (args) => {
    const rig = openCodeRig();
    const result = runCn(["opencode", ...args], { env: rig.env });
    expect(result.status, result.stderr).toBe(0);
    expect(rig.calls().at(-1).args).toStrictEqual([
      "run",
      "--standalone",
      "--session",
      "ses_existing",
      "hello",
    ]);
  },
);

test("OpenCode keeps --session after a subcommand and creates new named sessions: new session", () => {
  const rig = openCodeRig();
  // `--session <new id>` creates the session: a 404 from the switch is not an error.
  const created = runCn(["opencode", "--", "--session", "ses_new"], {
    env: rig.env,
  });
  expect(created.status, created.stderr).toBe(0);
  expect(rig.calls().at(-1).args).toStrictEqual([
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
  expect(codexSessions(env)).toMatchObject([{ id: "interactive" }]);
  expect(
    await resolveSessionArgs("codex", "unused", ["resume", "--last"], env),
  ).toStrictEqual(["resume", "interactive"]);
  expect(
    codexSessions(env, process.cwd(), {
      includeNonInteractive: true,
    }),
  ).toMatchObject([
    { id: "subagent" },
    { id: "scripted" },
    { id: "interactive" },
  ]);
  expect(
    await resolveSessionArgs(
      "codex",
      "unused",
      ["resume", "--last", "--include-non-interactive"],
      env,
    ),
  ).toStrictEqual(["resume", "subagent", "--include-non-interactive"]);
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
  expect(codexSessions(env)).toMatchObject([{ id: "big" }]);
});

test.each([[[]], [["--include-non-interactive"]]])(
  "codex exec resume --last continues scripted runs and never forwards the picker-only flag: %j",
  async (extra) => {
    const { env } = rig();
    const file = (id) =>
      path.join(env.CODEX_HOME, "sessions", "2026", "10", "27", `${id}.jsonl`);
    const meta = (id, source) => ({
      type: "session_meta",
      payload: { id, cwd: process.cwd(), source },
    });
    save(file("scripted"), meta("scripted", "exec"), 0);
    save(
      file("subagent"),
      meta("subagent", { subagent: { other: "x" } }),
      10000,
    );
    expect(
      await resolveSessionArgs(
        "codex",
        "unused",
        ["exec", "resume", "--last", ...extra, "go"],
        env,
      ),
    ).toStrictEqual(["exec", "resume", "scripted", "go"]);
  },
);

test("Claude session aliases preserve IDs, native flags, model overrides, and literal prompts", () => {
  expect(
    parseHarnessLaunchArgs("claude", ["resume", "saved-session"]),
  ).toStrictEqual({
    model: undefined,
    forwarded: ["--resume", "saved-session"],
  });
  expect(
    parseHarnessLaunchArgs("claude", ["continue"]).forwarded,
  ).toStrictEqual(["--continue"]);
  expect(parseHarnessLaunchArgs("claude", ["resume"]).forwarded).toStrictEqual([
    "--resume",
  ]);
  expect(
    parseHarnessLaunchArgs("claude", [
      "--model",
      "claude-sonnet-5",
      "resume",
      "saved-session",
    ]),
  ).toStrictEqual({
    model: "claude-sonnet-5",
    forwarded: ["--resume", "saved-session"],
  });
  expect(
    parseHarnessLaunchArgs("claude", ["--", "resume"]).forwarded,
  ).toStrictEqual(["resume"]);
  expect(
    parseHarnessLaunchArgs("claude", [
      "resume",
      "saved-session",
      "--",
      "continue",
    ]).forwarded,
  ).toStrictEqual(["--resume", "saved-session", "--", "continue"]);
  expect(
    parseHarnessLaunchArgs("claude", ["--resume", "saved-session"]).forwarded,
  ).toStrictEqual(["--resume", "saved-session"]);
  expect(
    parseHarnessLaunchArgs("codex", ["resume", "saved-session"]).forwarded,
  ).toStrictEqual(["resume", "saved-session"]);
});
