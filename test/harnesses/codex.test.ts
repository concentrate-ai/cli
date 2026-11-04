import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import { fakeTool, runCn, tempDir, setup } from "../helpers.js";
import { modelsFor } from "../../src/lib/catalog.js";
import { writeCodexCatalog } from "../../src/lib/harnesses/pickers.js";

test("codex gets per-run provider overrides and the key only in env", () => {
  const { bin, env } = setup();
  const record = fakeTool(bin, "codex");
  const result = runCn(["codex", "--", "exec", "hi"], { env });
  expect(result.status, result.stderr).toBe(0);
  const seen = record();
  expect(seen.env.CONCENTRATE_API_KEY).toBe("sk-test");
  const joined = seen.args.join("\n");
  expect(joined).toMatch(/model_provider="concentrate"/);
  expect(joined).toMatch(/model_catalog_json=/);
  expect(joined).toMatch(
    /model_providers\.concentrate\.base_url="https:\/\/api\.concentrate\.ai\/v1"/,
  );
  expect(joined).toMatch(
    /model_providers\.concentrate\.env_key="CONCENTRATE_API_KEY"/,
  );
  expect(joined).not.toContain("sk-test");
  expect(seen.args[seen.args.indexOf("-m") + 1]).toBe("gpt-6.1-terra");
  expect(seen.args.slice(-2)).toStrictEqual(["exec", "hi"]);
});

test("codex omits env_key when the saved provider already has a credential helper", () => {
  const { bin, env } = setup();
  const codexHome = env.CODEX_HOME;
  const record = fakeTool(bin, "codex");
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    '[model_providers.concentrate.auth]\ncommand = "/tmp/helper"\n',
  );
  expect(runCn(["codex", "--", "exec", "hi"], { env }).status).toBe(0);
  expect(record().args.join("\n")).not.toContain("env_key");
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "x"\n');
  expect(runCn(["codex", "--", "exec", "hi"], { env }).status).toBe(0);
  expect(record().args.join("\n")).toMatch(/env_key="CONCENTRATE_API_KEY"/);
});

test("codex runs without the shared background server", () => {
  const { bin, env } = setup();
  const record = fakeTool(bin, "codex");
  const result = runCn(["codex", "--", "exec", "hi"], { env });
  expect(result.status, result.stderr).toBe(0);
  expect(record().args).toContain("--no-daemon");
});

test("codex is limited to OpenAI models", async () => {
  const models = [
    { id: "gpt-5.5", codex: true, chat_candidate: true },
    { id: "o3", codex: true, chat_candidate: true },
    { id: "gpt-oss-120b", codex: true, chat_candidate: true },
    { id: "grok-4.7", codex: true, chat_candidate: true },
    { id: "gemini-3.8-flash", codex: true, chat_candidate: true },
  ];
  expect(modelsFor("codex", models)).toMatchObject([
    { id: "gpt-5.5" },
    { id: "o3" },
  ]);
});

test("a saved non-OpenAI Codex default falls back, and --model refuses one", () => {
  const { bin, env } = setup();
  const record = fakeTool(bin, "codex");
  fs.writeFileSync(
    path.join(env.CN_CONFIG_HOME, "config.json"),
    JSON.stringify({ models: { codex: "grok-4.7" } }),
    { mode: 0o600 },
  );
  const result = runCn(["codex", "--", "exec", "hi"], { env });
  expect(result.status, result.stderr).toBe(0);
  const { args } = record();
  expect(args[args.indexOf("-m") + 1]).toBe("gpt-6.1-terra");
  const refused = runCn(["codex", "--model", "grok-4.7"], { env });
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toMatch(/limited to OpenAI models/);
});

test("codex resumes directly with the original session ID and Concentrate settings", () => {
  const { bin, env } = setup();
  const record = fakeTool(bin, "codex");
  const session = "01a1830a-36f8-76c0-acb6-e82b2183af2b";
  const result = runCn(["codex", "resume", session], { env });
  expect(result.status, result.stderr).toBe(0);
  const seen = record();
  expect(seen.args.slice(-2)).toStrictEqual(["resume", session]);
  expect(seen.args.includes("--remote")).toBe(false);
  expect(seen.args.join("\n")).toMatch(/model_provider="concentrate"/);
  expect(seen.env.CONCENTRATE_API_KEY).toBe("sk-test");
});

test("the Codex catalog ranks models in cn's order, first model first", async () => {
  const dir = tempDir();
  const fakeCodex = path.join(dir, "codex");
  fakeTool(dir, "codex");
  const file = writeCodexCatalog(
    fakeCodex,
    [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ],
    path.join(dir, "models.json"),
  );
  expect(JSON.parse(fs.readFileSync(file, "utf8")).models).toMatchObject([
    { slug: "a", priority: 1 },
    { slug: "b", priority: 2 },
    { slug: "c", priority: 3 },
  ]);
});
