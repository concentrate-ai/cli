import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import {
  prepareCodexHandoff,
  codexOverrideConfig,
} from "../dist/lib/codex-daemon.js";
import { writeKey } from "../dist/lib/settings.js";

const id = "00000000-0000-0000-0000-000000000001";
const overrides = [
  'model_provider="concentrate"',
  'model_providers.concentrate.name="Concentrate AI"',
  'model_providers.concentrate.base_url="https://api.concentrate.ai/v1"',
  'model_providers.concentrate.env_key="CONCENTRATE_API_KEY"',
  'model_providers.concentrate.wire_api="responses"',
  'model_providers.concentrate.http_headers={"X-App"="codex"}',
];
const unix = process.platform !== "win32";

async function rig(t, behavior = {}) {
  const root = fs.mkdtempSync("/tmp/cn-handoff-test-");
  const env = {
    HOME: root,
    CODEX_HOME: path.join(root, "cx"),
    CN_CONFIG_HOME: path.join(root, "cn"),
  };
  const socketPath = path.join(
    env.CODEX_HOME,
    "app-server-control",
    "app-server-control.sock",
  );
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  const server = http.createServer();
  const ws = new WebSocketServer({ server });
  const calls = [];
  ws.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const call = JSON.parse(raw.toString());
      calls.push(call);
      if (call.id === undefined) return;
      let result;
      if (call.method === "initialize") result = { userAgent: "codex/test" };
      else if (call.method === "model/list")
        result = {
          data: [
            {
              id: "native",
              model: "native",
              futureField: "preserved",
              upgrade: "next-model",
            },
          ],
          nextCursor: "unused",
        };
      else if (call.method === "thread/loaded/list") {
        if (behavior.listError) {
          socket.send(
            JSON.stringify({
              id: call.id,
              error: { code: -32601, message: "no" },
            }),
          );
          return;
        }
        result = behavior.paged
          ? call.params.cursor === "page-2"
            ? { data: [id], nextCursor: null }
            : { data: ["other"], nextCursor: "page-2" }
          : { data: behavior.unloaded ? [] : [id], nextCursor: null };
      } else if (call.method === "thread/read")
        result = {
          thread: { id, status: { type: behavior.active ? "active" : "idle" } },
        };
      else if (call.method === "thread/resume") {
        if (behavior.disconnect) {
          socket.close();
          return;
        }
        if (behavior.error) {
          socket.send(
            JSON.stringify({
              id: call.id,
              error: {
                code: -32600,
                message: "secret-provider-error-sk-do-not-print",
              },
            }),
          );
          return;
        }
        result = {
          thread: { id },
          model: behavior.wrongModel ? "old-model" : call.params.model,
          modelProvider: behavior.ignored
            ? "openai"
            : call.params.modelProvider,
        };
      }
      socket.send(JSON.stringify({ id: call.id, result }));
    }),
  );
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const client of ws.clients) client.terminate();
    await new Promise((resolve) => ws.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    env,
    calls,
    socketPath,
    options: {
      forwarded: ["resume", id],
      overrides,
      model: "chosen",
      key: "sk-synthetic-handoff",
      env,
    },
  };
}

const command = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );

test("Codex override objects preserve last-wins nested tables", () => {
  assert.deepEqual(
    codexOverrideConfig([
      'model="old"',
      'provider.headers={a="first", b="keep"}',
      'provider.headers.a="last"',
      'model="new"',
    ]),
    { model: "new", provider: { headers: { a: "last", b: "keep" } } },
  );
});

test(
  "an idle CLI-owned session keeps its ID and uses scoped daemon credentials without writing the key",
  { skip: !unix },
  async (t) => {
    const { options, calls, socketPath } = await rig(t);
    const result = await prepareCodexHandoff(options);
    t.after(() => result?.cleanup());
    assert.ok(result.remote.startsWith("unix://"));
    assert.notEqual(result.remote, "unix://" + socketPath);
    const resume = calls.find((call) => call.method === "thread/resume").params;
    assert.equal(resume.threadId, id);
    assert.equal(resume.excludeTurns, true);
    assert.equal(resume.model, "chosen");
    const provider = resume.config.model_providers[resume.modelProvider];
    assert.equal(provider.env_key, undefined);
    assert.equal(provider.base_url, "https://api.concentrate.ai/v1");
    assert.equal(provider.http_headers["X-App"], "codex");
    assert.ok(!JSON.stringify(calls).includes(options.key));
    assert.ok(!result.overrides.join(" ").includes(options.key));
    const helper = provider.auth.args[0];
    assert.ok(!fs.readFileSync(helper, "utf8").includes(options.key));
    assert.equal(fs.statSync(path.dirname(helper)).mode & 0o777, 0o700);
    assert.equal(
      (await command(provider.auth.command, provider.auth.args)).trim(),
      options.key,
    );
    result.cleanup();
    assert.equal(fs.existsSync(helper), false);
  },
);

test(
  "saved keys are served from memory and stop working once cn exits",
  { skip: !unix },
  async (t) => {
    const { options, calls } = await rig(t);
    writeKey(options.key, options.env);
    const result = await prepareCodexHandoff(options);
    t.after(() => result?.cleanup());
    const params = calls.find((call) => call.method === "thread/resume").params;
    const auth = params.config.model_providers[params.modelProvider].auth;
    assert.notEqual(auth.args[1], "--credential-helper");
    assert.equal((await command(auth.command, auth.args)).trim(), options.key);
    result.cleanup();
    // The daemon keeps the thread loaded; it must not keep authenticating.
    await assert.rejects(command(auth.command, auth.args));
  },
);

test("unquoted -c values are taken as literal strings, as Codex does", () => {
  assert.deepEqual(
    codexOverrideConfig([
      "model_reasoning_effort=high",
      'model="quoted"',
      "profile.name=a b",
    ]),
    {
      model_reasoning_effort: "high",
      model: "quoted",
      profile: { name: "a b" },
    },
  );
});

test(
  "a background server that cannot answer the read-only checks falls back to native resume",
  { skip: !unix },
  async (t) => {
    const { options, calls } = await rig(t, { listError: true });
    assert.equal(await prepareCodexHandoff(options), null);
    assert.ok(!calls.some((call) => call.method === "thread/resume"));
  },
);

test(
  "a loaded session beyond the first page of the server's list is still found",
  { skip: !unix },
  async (t) => {
    const { options, calls } = await rig(t, { paged: true });
    const result = await prepareCodexHandoff(options);
    t.after(() => result?.cleanup());
    assert.ok(result);
    assert.ok(calls.some((call) => call.method === "thread/resume"));
  },
);

test(
  "active work is not interrupted and the model/provider is not changed",
  { skip: !unix },
  async (t) => {
    const { options, calls } = await rig(t, { active: true });
    await assert.rejects(
      prepareCodexHandoff(options),
      /still running or waiting/,
    );
    assert.ok(!calls.some((call) => call.method === "thread/resume"));
  },
);

test(
  "ignored provider changes, incorrect models and transport errors never start a prompt",
  { skip: !unix },
  async (t) => {
    for (const behavior of [
      { ignored: true },
      { wrongModel: true },
      { error: true },
      { disconnect: true },
    ]) {
      const { options, calls } = await rig(t, behavior);
      await assert.rejects(prepareCodexHandoff(options), (error) => {
        assert.ok(!error.message.includes("sk-do-not-print"));
        return true;
      });
      assert.ok(!calls.some((call) => call.method === "turn/start"));
      const params = calls.find(
        (call) => call.method === "thread/resume",
      ).params;
      const auth = params.config.model_providers[params.modelProvider].auth;
      assert.equal(
        fs.existsSync(auth.args[0]),
        false,
        "temporary credential helper was not cleaned up",
      );
    }
  },
);

test(
  "a session not loaded by the daemon keeps normal local resume behavior",
  { skip: !unix },
  async (t) => {
    const { options, calls } = await rig(t, { unloaded: true });
    assert.equal(await prepareCodexHandoff(options), null);
    assert.ok(!calls.some((call) => call.method === "thread/resume"));
    assert.equal(
      await prepareCodexHandoff({
        ...options,
        forwarded: ["exec", "resume", id],
      }),
      null,
    );
    assert.equal(
      await prepareCodexHandoff({
        ...options,
        forwarded: ["resume", id, "--remote", "unix:///explicit"],
      }),
      null,
    );
  },
);

test(
  "the native CLI relay supplies provider definitions without changing global settings",
  { skip: !unix },
  async (t) => {
    const { options, calls } = await rig(t);
    const handoff = await prepareCodexHandoff(options);
    t.after(() => handoff.cleanup());
    const { CodexRpc } = await import("../dist/lib/codex-daemon.js");
    const cli = await CodexRpc.connect(handoff.remote.slice("unix://".length));
    t.after(() => cli.close());
    const resumed = await cli.request("thread/resume", {
      threadId: id,
      model: options.model,
      modelProvider: "ignored-local-default",
      config: { model_reasoning_effort: "low" },
    });
    const params = calls
      .filter((call) => call.method === "thread/resume")
      .at(-1).params;
    assert.equal(resumed.thread.id, id);
    assert.ok(params.config.model_providers[params.modelProvider].auth);
    assert.equal(params.config.model_reasoning_effort, "low");
    assert.ok(
      !calls.some(
        (call) =>
          call.method.startsWith("config/") || call.method === "thread/archive",
      ),
    );
    assert.equal(
      fs.existsSync(path.join(options.env.CODEX_HOME, "config.toml")),
      false,
    );
    cli.close();
    handoff.cleanup();
  },
);

test(
  "the CLI relay rejects prompts for conversations whose routing was not verified",
  { skip: !unix },
  async (t) => {
    const behavior = {};
    const { options, calls } = await rig(t, behavior);
    const handoff = await prepareCodexHandoff(options);
    t.after(() => handoff.cleanup());
    const { CodexRpc } = await import("../dist/lib/codex-daemon.js");
    const cli = await CodexRpc.connect(handoff.remote.slice("unix://".length));
    t.after(() => cli.close());
    const other = "00000000-0000-0000-0000-000000000002";
    await assert.rejects(
      cli.request("turn/start", { threadId: other, input: [] }),
    );
    behavior.ignored = true;
    await assert.rejects(
      cli.request("thread/resume", { threadId: other, model: options.model }),
    );
    await assert.rejects(
      cli.request("thread/compact/start", { threadId: other }),
    );
    assert.ok(
      !calls.some((call) =>
        ["turn/start", "thread/compact/start"].includes(call.method),
      ),
    );
    cli.close();
    handoff.cleanup();
  },
);

test(
  "daemon model pickers retain cn's canonical catalog and its capability metadata",
  { skip: !unix },
  async (t) => {
    const { options } = await rig(t);
    const catalog = path.join(options.env.CODEX_HOME, "catalog.json");
    fs.writeFileSync(
      catalog,
      JSON.stringify({
        models: [
          {
            slug: "chosen",
            display_name: "Chosen model",
            supported_reasoning_levels: [{ effort: "low", description: "Low" }],
            default_reasoning_level: "low",
            input_modalities: ["text", "image"],
          },
        ],
      }),
    );
    options.overrides = [
      ...options.overrides,
      `model_catalog_json=${JSON.stringify(catalog)}`,
    ];
    const handoff = await prepareCodexHandoff(options);
    t.after(() => handoff.cleanup());
    const { CodexRpc } = await import("../dist/lib/codex-daemon.js");
    const cli = await CodexRpc.connect(handoff.remote.slice("unix://".length));
    t.after(() => cli.close());
    const models = await cli.request("model/list", {});
    assert.deepEqual(
      models.data.map((entry) => entry.id),
      ["chosen"],
    );
    assert.deepEqual(models.data[0].inputModalities, ["text", "image"]);
    assert.equal(models.data[0].defaultReasoningEffort, "low");
    assert.equal(models.data[0].isDefault, true);
    assert.equal(models.data[0].upgrade, null);
    assert.equal(models.data[0].futureField, "preserved");
    assert.equal(models.nextCursor, null);
    cli.close();
    handoff.cleanup();
  },
);
