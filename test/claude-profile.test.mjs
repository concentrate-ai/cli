import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { prepareClaudeProfile } from "../dist/lib/claude-profile.js";
import { tempDir } from "./helpers.mjs";

test("Claude profile isolates settings while sharing conversation files", () => {
  const root = tempDir("cn-profile-test-");
  const source = path.join(root, "original");
  fs.mkdirSync(path.join(source, "projects", "project"), { recursive: true });
  fs.mkdirSync(path.join(source, "skills"));
  fs.writeFileSync(path.join(source, "skills", "skill.md"), "original skill");
  fs.writeFileSync(
    path.join(root, "settings.json"),
    '{"model":"sonnet","theme":"dark"}',
  );
  fs.symlinkSync(
    path.join(root, "settings.json"),
    path.join(source, "settings.json"),
  );
  fs.writeFileSync(
    path.join(source, ".claude.json"),
    '{"hasCompletedOnboarding":true}',
  );
  fs.writeFileSync(
    path.join(source, ".credentials.json"),
    '{"secret":"do not copy"}',
  );
  const session = path.join(source, "projects", "project", "existing.jsonl");
  fs.writeFileSync(session, "existing conversation\n");
  const profile = prepareClaudeProfile({ CLAUDE_CONFIG_DIR: source });
  try {
    assert.equal(
      fs
        .lstatSync(path.join(profile.directory, "settings.json"))
        .isSymbolicLink(),
      false,
    );
    fs.writeFileSync(
      path.join(profile.directory, "settings.json"),
      '{"model":"deepseek"}',
    );
    assert.equal(
      fs.readFileSync(path.join(root, "settings.json"), "utf8"),
      '{"model":"sonnet","theme":"dark"}',
    );
    assert.equal(
      fs.existsSync(path.join(profile.directory, ".credentials.json")),
      false,
    );
    assert.equal(
      fs.readFileSync(
        path.join(profile.directory, "projects", "project", "existing.jsonl"),
        "utf8",
      ),
      "existing conversation\n",
    );
    fs.appendFileSync(
      path.join(profile.directory, "projects", "project", "existing.jsonl"),
      "continued\n",
    );
    assert.equal(
      fs.readFileSync(session, "utf8"),
      "existing conversation\ncontinued\n",
    );
    fs.writeFileSync(
      path.join(profile.directory, "skills", "skill.md"),
      "changed copy",
    );
    assert.equal(
      fs.readFileSync(path.join(source, "skills", "skill.md"), "utf8"),
      "original skill",
    );
  } finally {
    profile.cleanup();
  }
  assert.equal(fs.existsSync(profile.directory), false);
  assert.equal(fs.existsSync(session), true);
});

test("MCP servers and approvals changed in a session are saved to the real file", () => {
  const root = tempDir("cn-profile-mcp-");
  const real = path.join(root, ".claude.json");
  fs.writeFileSync(
    real,
    JSON.stringify({
      theme: "dark",
      mcpServers: { keep: { command: "a" }, drop: { command: "b" } },
      projects: { "/p": { enabledMcpjsonServers: ["x"] } },
    }),
  );
  const profile = prepareClaudeProfile({ HOME: root });
  try {
    const copy = path.join(profile.directory, ".claude.json");
    const doc = JSON.parse(fs.readFileSync(copy, "utf8"));
    doc.mcpServers.added = { command: "c" };
    delete doc.mcpServers.drop;
    doc.projects["/p"].enabledMcpjsonServers = ["x", "y"];
    doc.theme = "light";
    fs.writeFileSync(copy, JSON.stringify(doc));
    // Edited elsewhere while the session ran.
    const live = JSON.parse(fs.readFileSync(real, "utf8"));
    live.other = true;
    fs.writeFileSync(real, JSON.stringify(live));
    profile.syncBack();
  } finally {
    profile.cleanup();
  }
  const saved = JSON.parse(fs.readFileSync(real, "utf8"));
  assert.deepEqual(Object.keys(saved.mcpServers).sort(), ["added", "keep"]);
  assert.deepEqual(saved.projects["/p"].enabledMcpjsonServers, ["x", "y"]);
  assert.equal(saved.theme, "dark");
  assert.equal(saved.other, true);
});

test("saving MCP changes keeps a symlinked ~/.claude.json a symlink", () => {
  const root = tempDir("cn-profile-mcp-link-");
  const real = path.join(root, "dotfiles-claude.json");
  fs.writeFileSync(real, JSON.stringify({ mcpServers: {} }));
  fs.symlinkSync(real, path.join(root, ".claude.json"));
  const profile = prepareClaudeProfile({ HOME: root });
  try {
    const copy = path.join(profile.directory, ".claude.json");
    const doc = JSON.parse(fs.readFileSync(copy, "utf8"));
    doc.mcpServers.added = { command: "c" };
    fs.writeFileSync(copy, JSON.stringify(doc));
    profile.syncBack();
  } finally {
    profile.cleanup();
  }
  assert.ok(fs.lstatSync(path.join(root, ".claude.json")).isSymbolicLink());
  assert.ok(JSON.parse(fs.readFileSync(real, "utf8")).mcpServers.added);
});

test("cn claude launches share one device ID, so the prompt cache stays warm", () => {
  const root = tempDir("cn-profile-device-");
  const env = { HOME: root, CN_CONFIG_HOME: path.join(root, "cn") };
  const ids = [1, 2].map(() => {
    const profile = prepareClaudeProfile(env);
    try {
      return JSON.parse(
        fs.readFileSync(path.join(profile.directory, ".claude.json"), "utf8"),
      ).userID;
    } finally {
      profile.cleanup();
    }
  });
  assert.match(ids[0], /^[0-9a-f]{64}$/);
  assert.equal(ids[0], ids[1]);
  // The user's own ID, when Claude already made one, is kept.
  fs.writeFileSync(
    path.join(root, ".claude.json"),
    JSON.stringify({ userID: "mine", theme: "dark" }),
  );
  const profile = prepareClaudeProfile(env);
  try {
    const doc = JSON.parse(
      fs.readFileSync(path.join(profile.directory, ".claude.json"), "utf8"),
    );
    assert.equal(doc.userID, "mine");
    assert.equal(doc.theme, "dark");
  } finally {
    profile.cleanup();
  }
});
