import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, expect } from "vitest";
import { summarize } from "../src/lib/catalog.js";
import { writeJson, writePreferences } from "../src/lib/config/settings.js";
import { fakeTool, tempDir } from "./helpers.js";

const root = fileURLToPath(new URL("../", import.meta.url));

// Source installs build in place, so each runs from its own copy of the checkout.
function checkout(dir) {
  const copy = path.join(dir, "checkout");
  fs.cpSync(root, copy, {
    recursive: true,
    filter: (source) =>
      !["node_modules", "dist", "release", ".git"].includes(
        path.basename(source),
      ),
  });
  return copy;
}

const model = (id) =>
  summarize({
    id,
    name: id,
    max_input_tokens: 32768,
    max_tokens: 4096,
    integrations: {
      claude_code: { supported: true },
      codex: { supported: true },
    },
    providers: {
      a: {
        supports: {
          input: { text: true },
          tools: { function_calling: true },
        },
      },
    },
  });

test("source install produces a self-contained CLI and launches all four adapters", () => {
  const dir = tempDir("cn-ts-install-");
  const home = path.join(dir, "home with spaces");
  const data = path.join(dir, "runtime $data");
  const bin = path.join(dir, "tools");
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_DATA_HOME: data,
    CN_CONFIG_HOME: path.join(dir, "config"),
    CN_OFFLINE: "1",
    CONCENTRATE_API_KEY: "sk-test",
    PI_CODING_AGENT_DIR: path.join(dir, "pi"),
  };
  const installed = spawnSync(
    "bash",
    [path.join(checkout(dir), "install.sh")],
    {
      env,
      encoding: "utf8",
      timeout: 30000,
    },
  );
  expect(installed.status, installed.stderr).toBe(0);
  const runtime = path.join(data, "concentrate-cli");
  expect(fs.existsSync(path.join(runtime, "node_modules"))).toBe(false);
  expect(fs.existsSync(path.join(runtime, "src"))).toBe(false);
  expect(
    fs.existsSync(
      path.join(runtime, "dist/lib/claude/claude-context/register.mjs"),
    ),
  ).toBe(true);
  const cn = path.join(home, ".local/bin/cn");
  const run = (args) =>
    spawnSync(cn, args, { env, encoding: "utf8", timeout: 10000 });
  expect(run(["--version"]).stdout.trim()).toBe(
    JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)))
      .version,
  );
  expect(run(["--help"]).stdout).toMatch(/claude, codex, opencode, pi/);
  const models = [model("small"), model("large")];
  writeJson(path.join(env.CN_CONFIG_HOME, "catalog.json"), {
    version: 6,
    fetchedAt: Date.now() / 1000,
    models,
  });
  writePreferences(
    { claude: "small", codex: "small", opencode: "small", pi: "small" },
    env,
  );
  const launch = (name) => {
    const record = fakeTool(bin, name);
    const result = run([name]);
    expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    return record();
  };
  expect(launch("claude").args.length).toBeGreaterThan(0);
  expect(launch("codex").args.length).toBeGreaterThan(0);
  launch("opencode");
  expect(launch("pi").args.length).toBeGreaterThan(0);
});

test("a source checkout without pnpm fails before anything is installed", () => {
  const dir = tempDir("cn-ts-install-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  const data = path.join(dir, "data");
  const result = spawnSync("bash", [path.join(root, "install.sh")], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, XDG_DATA_HOME: data },
    encoding: "utf8",
    timeout: 30000,
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/pnpm is required/);
  expect(fs.existsSync(path.join(data, "concentrate-cli"))).toBe(false);
});
