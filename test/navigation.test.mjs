import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BIN } from "./helpers.mjs";

const python = spawnSync("python3", ["--version"]);
test(
  "interactive actions stay in cn and support returning to home",
  {
    skip: process.platform === "win32" || python.status !== 0,
  },
  () => {
    const fixture = fileURLToPath(
      new URL("./fixtures/navigation.py", import.meta.url),
    );
    const result = spawnSync("python3", [fixture, process.execPath, BIN], {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
);
