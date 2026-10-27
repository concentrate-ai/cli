import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { tempDir } from "./helpers.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
function fixture() {
  const dir = fs.realpathSync(tempDir("cn-web-install-"));
  const home = path.join(dir, "home with spaces");
  fs.mkdirSync(home);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const downloads = path.join(dir, "downloads");
  fs.mkdirSync(downloads);
  const archive = path.join(downloads, "concentrate-cli.tar.gz");
  execFileSync("tar", [
    "-czf",
    archive,
    "-C",
    root,
    "dist",
    "package.json",
    "install.sh",
  ]);
  const hash = createHash("sha256")
    .update(fs.readFileSync(archive))
    .digest("hex");
  fs.writeFileSync(
    path.join(downloads, "SHA256SUMS"),
    `${hash}  concentrate-cli.tar.gz\n`,
  );
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!${process.execPath}\nimportDummy();\nfunction importDummy(){const fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);const url=args.find(arg=>arg.startsWith('https://'));fs.appendFileSync(process.env.CN_TEST_URLS,url+'\\n');const file=path.basename(new URL(url).pathname);const out=args[args.indexOf('-o')+1];const stale=path.join(process.env.CN_TEST_DOWNLOADS,'SHA256SUMS.stale');if(file==='SHA256SUMS'&&fs.existsSync(stale)){fs.copyFileSync(stale,out);fs.rmSync(stale);return;}fs.copyFileSync(path.join(process.env.CN_TEST_DOWNLOADS,file),out);}\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "npm"),
    '#!/bin/sh\necho "Unexpected npm build" >&2\nexit 99\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, "data"),
    CN_CONFIG_HOME: path.join(home, "config"),
    PATH: `${bin}:${process.env.PATH}`,
    CN_TEST_DOWNLOADS: downloads,
    CN_TEST_URLS: path.join(dir, "urls"),
    CN_INSTALL_VERSION: "latest",
  };
  fs.mkdirSync(env.CN_CONFIG_HOME);
  fs.writeFileSync(
    path.join(env.CN_CONFIG_HOME, "credentials.json"),
    "private-test-data",
    { mode: 0o600 },
  );
  const run = (extra = {}) =>
    spawnSync("bash", [], {
      input: installer,
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 20000,
    });
  return {
    dir,
    home,
    bin,
    downloads,
    env,
    run,
    launcher: path.join(home, ".local/bin/cn"),
    runtime: path.join(env.XDG_DATA_HOME, "concentrate-cli"),
  };
}
test("piped web install verifies a built release, needs no npm, preserves credentials and supports pinned releases", () => {
  const f = fixture();
  const result = f.run({ CN_INSTALL_VERSION: "0.1.1" });
  assert.equal(result.status, 0, result.stderr);
  const version = spawnSync(f.launcher, ["--version"], {
    env: f.env,
    encoding: "utf8",
  });
  assert.equal(version.stdout.trim(), "0.1.1");
  assert.match(
    fs.readFileSync(f.env.CN_TEST_URLS, "utf8"),
    /https:\/\/concentrate\.ai\/downloads\/cli\/v0\.1\.1\/concentrate-cli.tar.gz/,
  );
  assert.equal(fs.existsSync(path.join(f.runtime, "node_modules")), false);
  assert.equal(
    fs.readFileSync(
      path.join(f.env.CN_CONFIG_HOME, "credentials.json"),
      "utf8",
    ),
    "private-test-data",
  );
});
test("a failed checksum preserves the existing installation", () => {
  const f = fixture();
  assert.equal(f.run().status, 0);
  const original = fs.readFileSync(f.launcher, "utf8");
  fs.writeFileSync(path.join(f.runtime, "keep"), "old-runtime");
  fs.writeFileSync(
    path.join(f.downloads, "SHA256SUMS"),
    `${"0".repeat(64)}  concentrate-cli.tar.gz\n`,
  );
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA-256 verification/);
  assert.equal(fs.readFileSync(f.launcher, "utf8"), original);
  assert.equal(
    fs.readFileSync(path.join(f.runtime, "keep"), "utf8"),
    "old-runtime",
  );
});
test("an upgrade rolls back its runtime if launcher replacement fails", () => {
  const f = fixture();
  assert.equal(f.run().status, 0);
  const original = fs.readFileSync(f.launcher, "utf8");
  fs.writeFileSync(path.join(f.runtime, "keep"), "old-runtime");
  fs.writeFileSync(
    path.join(f.bin, "mv"),
    `#!/bin/sh\nfor arg do last="$arg"; done\nif [ "$last" = "$HOME/.local/bin/cn" ]; then exit 1; fi\nexec /bin/mv "$@"\n`,
    { mode: 0o755 },
  );
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(f.launcher, "utf8"), original);
  assert.equal(
    fs.readFileSync(path.join(f.runtime, "keep"), "utf8"),
    "old-runtime",
  );
  assert.deepEqual(fs.readdirSync(path.dirname(f.runtime)), [
    "concentrate-cli",
  ]);
});
test("web installer refuses an unrelated cn and invalid release selectors", () => {
  const f = fixture();
  assert.notEqual(f.run({ CN_INSTALL_VERSION: "../../other" }).status, 0);
  fs.mkdirSync(path.dirname(f.launcher), { recursive: true });
  fs.writeFileSync(f.launcher, "#!/bin/sh\necho unrelated\n", { mode: 0o755 });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /different cn command/);
  assert.match(fs.readFileSync(f.launcher, "utf8"), /unrelated/);
});
test("a checksum file from the previous release is retried instead of failing the install", () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.downloads, "SHA256SUMS.stale"),
    `${"0".repeat(64)}  concentrate-cli.tar.gz\n`,
  );
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const urls = fs.readFileSync(f.env.CN_TEST_URLS, "utf8").trim().split("\n");
  assert.equal(urls.filter((url) => url.endsWith("SHA256SUMS")).length, 2);
});
test("bash users on macOS or with a .bash_profile are told to edit .bash_profile", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, ".bash_profile"), "");
  const result = f.run({ SHELL: "/bin/bash" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Add this line to .*\.bash_profile/);
});
