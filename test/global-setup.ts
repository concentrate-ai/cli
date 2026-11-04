import { execFileSync } from "node:child_process";

// Black-box tests spawn dist/bin/cn.js; build once so no run sees a stale dist.
export default function setup() {
  execFileSync("pnpm", ["build"], { stdio: "inherit" });
}
