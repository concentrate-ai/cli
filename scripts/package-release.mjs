import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version))
  throw new Error("Invalid package version");
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${pkg.version}`)
  throw new Error("Release tag must match package.json version");
const output = path.join(root, "release");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cn-release-"));
try {
  for (const file of [
    "dist",
    "package.json",
    "install.sh",
    "README.md",
    "docs",
  ])
    fs.cpSync(path.join(root, file), path.join(temporary, file), {
      recursive: true,
    });
  fs.mkdirSync(output, { recursive: true });
  const name = "concentrate-cli.tar.gz";
  const archive = path.join(output, name);
  execFileSync(
    "tar",
    [
      "-czf",
      archive,
      "-C",
      temporary,
      "dist",
      "package.json",
      "install.sh",
      "README.md",
      "docs",
    ],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  const hash = createHash("sha256")
    .update(fs.readFileSync(archive))
    .digest("hex");
  fs.writeFileSync(path.join(output, "SHA256SUMS"), `${hash}  ${name}\n`);
  fs.copyFileSync(
    path.join(root, "install.sh"),
    path.join(output, "install.sh"),
  );
  console.log(`Prepared ${pkg.version}: ${archive}`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
