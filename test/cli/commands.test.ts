import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import { maskKey } from "../../src/lib/cli/commands.js";
import { parseFlags, parseLaunchArgs } from "../../src/lib/cli/cli.js";
import { which } from "../../src/lib/cli/launch.js";
import { DEFAULT_MODELS } from "../../src/lib/config/settings.js";
import { fakeTool, runCn, setup, tempDir, writeCatalog } from "../helpers.js";

test("a missing tool fails fast with exit 127, an install hint, and no key or network needed", () => {
  const { bin, env } = setup({ CONCENTRATE_API_KEY: "" });
  // Node's own directory can also contain globally installed coding agents.
  env.PATH = bin;
  const result = runCn(["codex"], { env });
  expect(result.status).toBe(127);
  expect(result.stderr).toMatch(/Codex CLI isn't installed/);
  expect(result.stderr).toMatch(/npm install -g @openai\/codex/);
  expect(result.stderr).not.toMatch(/Usage:/);
  expect(result.stderr).not.toMatch(/API key/);
});

test("an installed tool with no key tells the user to run setup", () => {
  const { bin, env } = setup({ CONCENTRATE_API_KEY: "" });
  fakeTool(bin, "claude");
  const result = runCn(["claude"], { env });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Run cn setup first/);
});

test("the tool's exit code is propagated", () => {
  const { bin, env } = setup();
  fakeTool(bin, "claude", { exitCode: 7 });
  expect(runCn(["claude"], { env }).status).toBe(7);
});

test("argument parsing", () => {
  expect(parseLaunchArgs([])).toStrictEqual({
    model: undefined,
    forwarded: [],
  });
  expect(parseLaunchArgs(["--model", "m", "--", "-p", "x"])).toStrictEqual({
    model: "m",
    forwarded: ["-p", "x"],
  });
  expect(parseLaunchArgs(["--model=m"])).toStrictEqual({
    model: "m",
    forwarded: [],
  });
  expect(parseLaunchArgs(["-p", "x"])).toStrictEqual({
    model: undefined,
    forwarded: ["-p", "x"],
  });
  expect(() => parseLaunchArgs(["--model"])).toThrow(/needs a model ID/);
  expect(() => parseFlags(["--nope"])).toThrow(/Unknown option/);
  expect(
    parseFlags(["claude", "--search", "x"], { values: ["search"] }),
  ).toStrictEqual({
    flags: { search: "x" },
    positionals: ["claude"],
  });
});

test("unknown commands and tools exit 2", () => {
  const { env } = setup();
  expect(runCn(["bogus"], { env }).status).toBe(2);
  expect(runCn(["model", "nope"], { env }).status).toBe(2);
  expect(runCn(["models", "--limit", "0"], { env }).status).toBe(2);
});

test("setup asks only for the key; config, model, and logout work end to end", () => {
  const { config, env } = setup({ CONCENTRATE_API_KEY: "" });
  const setupResult = runCn(["setup", "--no-verify"], {
    env,
    input: "sk-piped\n",
  });
  expect(setupResult.status, setupResult.stderr).toBe(0);
  expect(setupResult.stdout).toMatch(/ready/);
  expect(setupResult.stdout).toMatch(
    new RegExp(`cn claude\\s+${DEFAULT_MODELS.claude}`),
  );
  expect(setupResult.stdout, "no per-tool model questions").not.toMatch(
    /default model/,
  );
  expect(
    JSON.parse(fs.readFileSync(path.join(config, "credentials.json"), "utf8"))
      .api_key,
  ).toBe("sk-piped");
  expect(
    fs.existsSync(path.join(config, "config.json")),
    "defaults need no config file",
  ).toBe(false);

  const modelResult = runCn(["model", "claude", "claude-opus-4-6"], { env });
  expect(modelResult.stdout).toMatch(
    /Claude Code\s+default model claude-opus-4-6/,
  );
  const configResult = runCn(["config"], { env });
  expect(configResult.stdout).toMatch(/api key\s+stored/);
  expect(configResult.stdout).toMatch(/Claude Code\s+claude-opus-4-6/);
  expect(configResult.stdout).not.toMatch(/sk-piped/);

  expect(runCn(["logout"], { env }).stdout).toMatch(/saved key removed/);
  expect(runCn(["config"], { env }).stdout).toMatch(/api key\s+missing/);
});

test("setup --models also asks for each tool's default", () => {
  const { config, env } = setup({ CONCENTRATE_API_KEY: "" });
  const result = runCn(["setup", "--no-verify", "--models"], {
    env,
    input: "sk-piped\n\n\n\n\n",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/Claude Code default model/);
  expect(fs.existsSync(path.join(config, "config.json"))).toBe(true);
});

test("reset needs --yes when not interactive, keeps Pi sessions, and can remove them", () => {
  const { config, env } = setup({ CONCENTRATE_API_KEY: "" });
  runCn(["setup", "--no-verify"], { env, input: "sk-piped\n\n\n\n" });
  fs.mkdirSync(path.join(config, "pi-sessions"));
  fs.writeFileSync(path.join(config, "pi-sessions", "s.jsonl"), "{}");

  const refused = runCn(["reset"], { env });
  expect(refused.status).toBe(2);
  expect(refused.stderr).toMatch(/--yes/);
  expect(
    fs.existsSync(path.join(config, "credentials.json")),
    "nothing removed without confirmation",
  ).toBe(true);

  const done = runCn(["reset", "--yes"], { env });
  expect(done.status, done.stderr).toBe(0);
  expect(done.stdout).toMatch(/removed\s+credentials\.json/);
  expect(done.stdout).toMatch(/Pi sessions/);
  expect(fs.existsSync(path.join(config, "credentials.json"))).toBe(false);
  expect(fs.existsSync(path.join(config, "config.json"))).toBe(false);
  expect(fs.existsSync(path.join(config, "catalog.json"))).toBe(false);
  expect(
    fs.existsSync(path.join(config, "pi-sessions", "s.jsonl")),
    "sessions are kept by default",
  ).toBe(true);

  expect(runCn(["reset", "--yes", "--sessions"], { env }).status).toBe(0);
  expect(fs.existsSync(config), "empty config dir is removed").toBe(false);
  expect(runCn(["reset"], { env }).stdout).toMatch(/already fresh/);
});

test("reset leaves an environment key alone and says so", () => {
  const { config, env } = setup({ CONCENTRATE_API_KEY: "sk-env" });
  runCn(["model", "claude", "claude-opus-4-6"], { env });
  const result = runCn(["reset", "--yes"], { env });
  expect(result.stdout).toMatch(/CONCENTRATE_API_KEY is still set/);
  expect(fs.existsSync(path.join(config, "config.json"))).toBe(false);
});

test("a relative PATH entry never resolves a tool from the current directory", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "claude"), "#!/bin/sh\n", { mode: 0o755 });
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    expect(which("claude", ".")).toBe(null);
    expect(which("claude", dir)).toBe(path.join(dir, "claude"));
  } finally {
    process.chdir(cwd);
  }
});

test("a model ID that looks like a flag is refused before anything launches", () => {
  const { bin, env } = setup();
  fakeTool(bin, "claude");
  const result = runCn(
    ["claude", "--model", "--dangerously-skip-permissions"],
    { env },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/Not a valid model ID/);
  expect(fs.existsSync(path.join(bin, "claude.record.json"))).toBe(false);
});

test("maskKey hides the key and shows only the last four characters", () => {
  expect(maskKey("sk-live-abcdef123456")).toBe("••••••••3456");
  expect(maskKey("short")).toBe("••••••••");
});

test("keeping the default at the model prompt saves nothing, so the tool follows newer releases", () => {
  const { config, env } = setup();
  const flash = { id: "deepseek-v4-1-flash", released: "2026-09-10" };
  writeCatalog(config, [flash]);
  const kept = runCn(["model", "pi"], { env, input: "\n" });
  expect(kept.status, kept.stderr).toBe(0);
  writeCatalog(config, [
    flash,
    { id: "deepseek-v5-flash", released: "2026-12-01" },
  ]);
  expect(runCn(["config"], { env }).stdout).toMatch(/Pi\s+deepseek-v5-flash/);
});
