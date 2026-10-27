import { build } from "esbuild";
import fs from "node:fs";
const notices = [
  ["smol-toml", "LICENSE"],
  ["jsonc-parser", "LICENSE.md"],
]
  .map(
    ([name, file]) =>
      `${name}\n${fs.readFileSync(`node_modules/${name}/${file}`, "utf8")}`,
  )
  .join("\n\n");
await build({
  entryPoints: ["src/lib/config-formats.ts"],
  outfile: "dist/lib/config-formats.js",
  bundle: true,
  mainFields: ["module", "main"],
  platform: "node",
  format: "esm",
  target: "node18.18",
  external: ["./validation.js", "./errors.js"],
  footer: {
    js: `/* Third-party notices:\n${notices.replaceAll("*/", "* /")}\n*/`,
  },
});
await build({
  entryPoints: ["src/lib/codex-daemon.ts", "src/lib/codex-relay.ts"],
  outdir: "dist/lib",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18.18",
  external: [
    "./errors.js",
    "./config-formats.js",
    "./settings.js",
    "./validation.js",
    "bufferutil",
    "utf-8-validate",
  ],
  banner: {
    js: 'import { createRequire as cnCreateRequire } from "node:module"; const require = cnCreateRequire(import.meta.url);',
  },
  footer: {
    js: `/* ws license:\n${fs.readFileSync("node_modules/ws/LICENSE", "utf8").replaceAll("*/", "* /")}\n*/`,
  },
});
