import { test, expect } from "vitest";
import {
  isNewer,
  refreshConfiguredTools,
  updateNotice,
} from "../src/lib/cli/update.js";
import { writeJson } from "../src/lib/config/settings.js";
import { version } from "../src/lib/version.js";
import path from "node:path";
import { tempDir } from "./helpers.js";
import {
  changesSince,
  changelogSections,
  readChangelog,
} from "../src/lib/changelog.js";

const currentOrNewer = (sections) =>
  sections.filter((s) => !isNewer(version(), s.version));

test("update compares versions numerically", () => {
  expect(isNewer("0.1.1", "0.1.0")).toBe(true);
  expect(isNewer("0.10.0", "0.9.0")).toBe(true);
  expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  expect(isNewer("0.1.0", "0.1.0")).toBe(false);
  expect(isNewer("0.1.0", "0.1.1")).toBe(false);
});

test("the update notice comes from a daily cache and names the newer version", async () => {
  const config = tempDir("cn-update-notice-");
  const env = { CN_CONFIG_HOME: config, HOME: config };
  const file = path.join(config, "update-check.json");
  const fresh = Date.now() / 1000;
  writeJson(file, { latest: "99.0.0", checkedAt: fresh });
  expect(await updateNotice(env)).toMatch(/cn 99\.0\.0 is available/);
  writeJson(file, { latest: version(), checkedAt: fresh });
  expect(await updateNotice(env)).toBe(null);
});

test("refreshing with nothing configured does nothing", async () => {
  const config = tempDir("cn-refresh-none-");
  const env = { CN_CONFIG_HOME: config, HOME: config };
  expect(await refreshConfiguredTools(env)).toBe(0);
});

test("the changelog lists releases newer than a given version", async () => {
  const text =
    "# Changelog\n\n## 0.2.0\n\n- b\n\n## 0.1.1\n\n- a\n\n## 0.1.0\n\n- first\n";
  expect(changelogSections(text)).toMatchObject([
    { version: "0.2.0" },
    { version: "0.1.1" },
    { version: "0.1.0" },
  ]);
  expect(changesSince(text, "0.1.0")).toBe("0.2.0\n- b\n\n0.1.1\n- a");
  expect(changesSince(text, "0.2.0")).toBe("");
  // The shipped changelog has a section for the current version or newer.
  const shipped = changelogSections(readChangelog());
  expect(currentOrNewer(shipped)).not.toHaveLength(0);
});
