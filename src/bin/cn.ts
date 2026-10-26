#!/usr/bin/env node
// Checked before loading anything else, so an old Node gets a clear message, not a stack trace.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 18 || (major === 18 && minor < 18)) {
  process.stderr.write(
    `cn needs Node.js 18.18 or newer (this is ${process.version}).\n`,
  );
  process.exit(1);
}

const { main } = await import("../lib/cli.js");
process.exitCode = await main();
