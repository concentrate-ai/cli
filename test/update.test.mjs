import assert from "node:assert/strict";
import test from "node:test";
import {
  isNewer,
  refreshConfiguredTools,
  updateNotice,
} from "../dist/lib/update.js";
import { writeJson } from "../dist/lib/settings.js";
import { version } from "../dist/lib/version.js";
import path from "node:path";
import { tempDir } from "./helpers.mjs";

test("update compares versions numerically", () => {
  assert.equal(isNewer("0.1.1", "0.1.0"), true);
  assert.equal(isNewer("0.10.0", "0.9.0"), true);
  assert.equal(isNewer("1.0.0", "0.99.99"), true);
  assert.equal(isNewer("0.1.0", "0.1.0"), false);
  assert.equal(isNewer("0.1.0", "0.1.1"), false);
});

test("the update notice comes from a daily cache and names the newer version", async () => {
  const config = tempDir("cn-update-notice-");
  const env = { CN_CONFIG_HOME: config, HOME: config };
  const file = path.join(config, "update-check.json");
  const fresh = Date.now() / 1000;
  writeJson(file, { latest: "99.0.0", checkedAt: fresh });
  assert.match(await updateNotice(env), /cn 99\.0\.0 is available/);
  writeJson(file, { latest: version(), checkedAt: fresh });
  assert.equal(await updateNotice(env), null);
});

test("refreshing with nothing configured does nothing", async () => {
  const config = tempDir("cn-refresh-none-");
  const env = { CN_CONFIG_HOME: config, HOME: config };
  assert.equal(await refreshConfiguredTools(env), 0);
});
