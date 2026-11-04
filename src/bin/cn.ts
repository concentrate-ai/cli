#!/usr/bin/env node
// Checked before loading anything else, so an old Node gets a clear message, not a stack trace.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(
    `cn needs Node.js 22.13 or newer (this is ${process.version}).\n`,
  );
  process.exit(1);
}

const { main } = await import("../lib/cli/cli.js");
process.exitCode = await main();
