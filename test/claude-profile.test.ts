import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import { prepareClaudeProfile } from "../src/lib/claude-profile.js";
import { tempDir } from "./helpers.js";

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
    expect(
      fs
        .lstatSync(path.join(profile.directory, "settings.json"))
        .isSymbolicLink(),
    ).toBe(false);
    fs.writeFileSync(
      path.join(profile.directory, "settings.json"),
      '{"model":"deepseek"}',
    );
    expect(fs.readFileSync(path.join(root, "settings.json"), "utf8")).toBe(
      '{"model":"sonnet","theme":"dark"}',
    );
    expect(
      fs.existsSync(path.join(profile.directory, ".credentials.json")),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(profile.directory, "projects", "project", "existing.jsonl"),
        "utf8",
      ),
    ).toBe("existing conversation\n");
    fs.appendFileSync(
      path.join(profile.directory, "projects", "project", "existing.jsonl"),
      "continued\n",
    );
    expect(fs.readFileSync(session, "utf8")).toBe(
      "existing conversation\ncontinued\n",
    );
    fs.writeFileSync(
      path.join(profile.directory, "skills", "skill.md"),
      "changed copy",
    );
    expect(
      fs.readFileSync(path.join(source, "skills", "skill.md"), "utf8"),
    ).toBe("original skill");
  } finally {
    profile.cleanup();
  }
  expect(fs.existsSync(profile.directory)).toBe(false);
  expect(fs.existsSync(session)).toBe(true);
});
const deviceId = (env) => {
  const profile = prepareClaudeProfile(env);
  try {
    return JSON.parse(
      fs.readFileSync(path.join(profile.directory, ".claude.json"), "utf8"),
    ).userID;
  } finally {
    profile.cleanup();
  }
};
test("cn claude launches share one device ID, so the prompt cache stays warm", () => {
  const root = tempDir("cn-profile-device-");
  const env = { HOME: root, CN_CONFIG_HOME: path.join(root, "cn") };
  const ids = [deviceId(env), deviceId(env)];
  expect(ids[0]).toMatch(/^[0-9a-f]{64}$/);
  expect(ids[0]).toBe(ids[1]);
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
    expect(doc.userID).toBe("mine");
    expect(doc.theme).toBe("dark");
  } finally {
    profile.cleanup();
  }
});
