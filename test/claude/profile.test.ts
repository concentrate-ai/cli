import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import { prepareClaudeProfile } from "../../src/lib/claude/claude-profile.js";
import { tempDir } from "../helpers.js";

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
  const profile = prepareClaudeProfile({
    CLAUDE_CONFIG_DIR: source,
    CN_CONFIG_HOME: path.join(root, "cn"),
  });
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

const launch = (env) => {
  const profile = prepareClaudeProfile(env);
  profile.cleanup();
  return profile;
};
const readProfile = (profile, name) =>
  fs.readFileSync(path.join(profile.directory, name), "utf8");
const sourceEnv = (prefix) => {
  const root = tempDir(prefix);
  const source = path.join(root, "claude");
  fs.mkdirSync(source);
  return {
    root,
    source,
    env: {
      HOME: root,
      CN_CONFIG_HOME: path.join(root, "cn"),
      CLAUDE_CONFIG_DIR: source,
    },
  };
};

test("every launch shares one profile, keeps what Claude saved there, and gets its own ended file", () => {
  const { root, env } = sourceEnv("cn-profile-shared-");
  const first = prepareClaudeProfile(env);
  fs.writeFileSync(
    path.join(first.directory, ".credentials.json"),
    '{"saved":true}',
  );
  const second = prepareClaudeProfile(env);
  expect(first.directory).toBe(path.join(root, "cn", "claude-profile"));
  expect(second.directory).toBe(first.directory);
  expect(fs.statSync(first.directory).mode & 0o777).toBe(0o700);
  expect(readProfile(second, ".credentials.json")).toBe('{"saved":true}');
  expect(second.ended).not.toBe(first.ended);
  fs.writeFileSync(first.ended, "");
  fs.writeFileSync(second.ended, "");
  first.cleanup();
  second.cleanup();
  expect(fs.existsSync(first.directory)).toBe(true);
  expect(fs.existsSync(first.ended)).toBe(false);
  expect(fs.existsSync(second.ended)).toBe(false);
});

test("customizations re-sync each launch, including deletions", () => {
  const { source, env } = sourceEnv("cn-profile-resync-");
  fs.mkdirSync(path.join(source, "skills"));
  fs.writeFileSync(path.join(source, "skills", "skill.md"), "v1");
  fs.writeFileSync(path.join(source, "CLAUDE.md"), "memory");
  fs.writeFileSync(path.join(source, "settings.json"), '{"model":"sonnet"}');
  const first = launch(env);
  fs.writeFileSync(
    path.join(first.directory, "settings.json"),
    '{"model":"x"}',
  );
  fs.writeFileSync(path.join(source, "skills", "skill.md"), "v2");
  fs.rmSync(path.join(source, "CLAUDE.md"));
  const second = launch(env);
  expect(readProfile(second, path.join("skills", "skill.md"))).toBe("v2");
  expect(fs.existsSync(path.join(second.directory, "CLAUDE.md"))).toBe(false);
  expect(readProfile(second, "settings.json")).toBe('{"model":"sonnet"}');
  expect(new Set(fs.readdirSync(second.directory))).toStrictEqual(
    new Set([
      ".claude.json",
      "cn-session-end.cjs",
      "projects",
      "settings.json",
      "skills",
    ]),
  );
});

test(".mcp.json approvals and folder trust given under cn survive the next launch", () => {
  const { source, env } = sourceEnv("cn-profile-approvals-");
  fs.writeFileSync(
    path.join(source, ".claude.json"),
    JSON.stringify({
      projects: { "/p": { enabledMcpjsonServers: ["a"] } },
      theme: "dark",
    }),
  );
  const first = launch(env);
  const state = JSON.parse(readProfile(first, ".claude.json"));
  state.projects["/p"] = {
    enabledMcpjsonServers: ["b"],
    disabledMcpjsonServers: ["c"],
    hasTrustDialogAccepted: true,
  };
  state.projects["/q"] = { hasTrustDialogAccepted: true };
  fs.writeFileSync(
    path.join(first.directory, ".claude.json"),
    JSON.stringify(state),
  );
  const merged = JSON.parse(readProfile(launch(env), ".claude.json"));
  expect(merged.projects["/p"]).toStrictEqual({
    enabledMcpjsonServers: ["a", "b"],
    disabledMcpjsonServers: ["c"],
    hasTrustDialogAccepted: true,
  });
  expect(merged.projects["/q"].hasTrustDialogAccepted).toBe(true);
  expect(merged.theme).toBe("dark");
  expect(merged.userID).toMatch(/^[0-9a-f]{64}$/);
});

test("projects follows the current Claude config dir", () => {
  const { root, env } = sourceEnv("cn-profile-projects-");
  const other = path.join(root, "other");
  launch(env);
  const profile = launch({ ...env, CLAUDE_CONFIG_DIR: other });
  expect(fs.realpathSync(path.join(profile.directory, "projects"))).toBe(
    fs.realpathSync(path.join(other, "projects")),
  );
});
