import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = process.argv[2];
if (
  !destination ||
  !path.isAbsolute(destination) ||
  !fs.statSync(destination).isDirectory()
)
  throw new Error(
    "Pass the absolute path to the website's existing public directory.",
  );
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version))
  throw new Error("Invalid release version");
const release = path.join(root, "release");
const name = "concentrate-cli.tar.gz";
const archive = fs.readFileSync(path.join(release, name));
const manifest = fs.readFileSync(path.join(release, "SHA256SUMS"), "utf8");
const hash = createHash("sha256").update(archive).digest("hex");
if (manifest.trim() !== `${hash}  ${name}`)
  throw new Error("Release checksum does not match; rebuild before staging.");
const install = fs.readFileSync(path.join(release, "install.sh"));
if (!install.equals(fs.readFileSync(path.join(root, "install.sh"))))
  throw new Error("The installer changed; rebuild before staging.");
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
// A published version is immutable: pinned installs and their checksums rely on it.
const published = path.join(
  destination,
  "downloads",
  "cli",
  `v${pkg.version}`,
  name,
);
if (fs.existsSync(published) && !fs.readFileSync(published).equals(archive))
  throw new Error(
    `v${pkg.version} is already staged with different contents. Increment the package version instead of replacing it.`,
  );
// Archive before checksum, versioned copy before `latest`.
for (const version of [`v${pkg.version}`, "latest"]) {
  const target = path.join(destination, "downloads", "cli", version);
  write(path.join(target, name), archive);
  write(path.join(target, "SHA256SUMS"), manifest);
}
write(path.join(destination, "cli", "install.sh"), install);
console.log(
  `Staged CLI ${pkg.version} at ${destination}/cli/install.sh and /downloads/cli/. No deployment performed.`,
);
