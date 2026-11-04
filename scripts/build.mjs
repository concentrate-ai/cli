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
  entryPoints: ["src/lib/config/config-formats.ts"],
  outfile: "dist/lib/config/config-formats.js",
  bundle: true,
  mainFields: ["module", "main"],
  platform: "node",
  format: "esm",
  target: "node22.13",
  // Our own modules stay shared (one CnError class); list any new relative import here.
  external: ["../validation.js", "../errors.js"],
  footer: {
    js: `/* Third-party notices:\n${notices.replaceAll("*/", "* /")}\n*/`,
  },
});
