import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, expect } from "vitest";
import { tempDir } from "../helpers.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
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
    "CHANGELOG.md",
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
    path.join(bin, "pnpm"),
    '#!/bin/sh\necho "Unexpected pnpm build" >&2\nexit 99\n',
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
test("piped web install verifies a built release, needs no pnpm, preserves credentials and supports pinned releases", () => {
  const f = fixture();
  const result = f.run({ CN_INSTALL_VERSION: "0.1.0" });
  expect(result.status, result.stderr).toBe(0);
  const version = spawnSync(f.launcher, ["--version"], {
    env: f.env,
    encoding: "utf8",
  });
  // The test serves a package built from this checkout, whatever its version.
  expect(version.stdout.trim()).toBe(
    JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
      .version,
  );
  expect(fs.readFileSync(f.env.CN_TEST_URLS, "utf8")).toMatch(
    /https:\/\/github\.com\/concentrateai-hq\/cli\/releases\/download\/v0\.1\.0\/concentrate-cli.tar.gz/,
  );
  expect(fs.existsSync(path.join(f.runtime, "node_modules"))).toBe(false);
  // The changelog ships with the install, for `cn changelog` and `cn update`.
  const notes = spawnSync(f.launcher, ["changelog"], {
    env: f.env,
    encoding: "utf8",
  });
  expect(notes.status, notes.stderr).toBe(0);
  expect(notes.stdout).toMatch(/^\d+\.\d+\.\d+/);
  expect(
    fs.readFileSync(
      path.join(f.env.CN_CONFIG_HOME, "credentials.json"),
      "utf8",
    ),
  ).toBe("private-test-data");
});
test("a failed checksum preserves the existing installation", () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  const original = fs.readFileSync(f.launcher, "utf8");
  fs.writeFileSync(path.join(f.runtime, "keep"), "old-runtime");
  fs.writeFileSync(
    path.join(f.downloads, "SHA256SUMS"),
    `${"0".repeat(64)}  concentrate-cli.tar.gz\n`,
  );
  const result = f.run();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/SHA-256 verification/);
  expect(fs.readFileSync(f.launcher, "utf8")).toBe(original);
  expect(fs.readFileSync(path.join(f.runtime, "keep"), "utf8")).toBe(
    "old-runtime",
  );
});
test("Node older than 22.13 is refused before anything is downloaded or installed", () => {
  const f = fixture();
  const preload = path.join(f.dir, "old-node.cjs");
  fs.writeFileSync(
    preload,
    'Object.defineProperty(process.versions, "node", { value: "22.12.0" });\n',
  );
  const result = f.run({ NODE_OPTIONS: `--require=${preload}` });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(
    /Node\.js 22\.13\+ is required \(found 22\.12\.0\)/,
  );
  expect(fs.existsSync(f.env.CN_TEST_URLS)).toBe(false);
  expect(fs.existsSync(f.launcher)).toBe(false);
});
test("an upgrade rolls back its runtime if launcher replacement fails", () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  const original = fs.readFileSync(f.launcher, "utf8");
  fs.writeFileSync(path.join(f.runtime, "keep"), "old-runtime");
  fs.writeFileSync(
    path.join(f.bin, "mv"),
    `#!/bin/sh\nfor arg do last="$arg"; done\nif [ "$last" = "$HOME/.local/bin/cn" ]; then exit 1; fi\nexec /bin/mv "$@"\n`,
    { mode: 0o755 },
  );
  const result = f.run();
  expect(result.status).not.toBe(0);
  expect(fs.readFileSync(f.launcher, "utf8")).toBe(original);
  expect(fs.readFileSync(path.join(f.runtime, "keep"), "utf8")).toBe(
    "old-runtime",
  );
  expect(fs.readdirSync(path.dirname(f.runtime))).toStrictEqual([
    "concentrate-cli",
  ]);
});
test("web installer refuses an unrelated cn and invalid release selectors", () => {
  const f = fixture();
  expect(f.run({ CN_INSTALL_VERSION: "../../other" }).status).not.toBe(0);
  fs.mkdirSync(path.dirname(f.launcher), { recursive: true });
  fs.writeFileSync(f.launcher, "#!/bin/sh\necho unrelated\n", { mode: 0o755 });
  const result = f.run();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/different cn command/);
  expect(fs.readFileSync(f.launcher, "utf8")).toMatch(/unrelated/);
});
test("a checksum file from the previous release is retried instead of failing the install", () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.downloads, "SHA256SUMS.stale"),
    `${"0".repeat(64)}  concentrate-cli.tar.gz\n`,
  );
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  const urls = fs.readFileSync(f.env.CN_TEST_URLS, "utf8");
  expect(urls.match(/SHA256SUMS$/gm)).toHaveLength(2);
});
test("bash users on macOS or with a .bash_profile are told to edit .bash_profile", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, ".bash_profile"), "");
  const result = f.run({ SHELL: "/bin/bash" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/Add this line to .*\.bash_profile/);
});
