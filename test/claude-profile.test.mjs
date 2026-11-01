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
