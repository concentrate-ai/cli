import { spawnSync } from "node:child_process";

// v2 talks to a shared background service unless told to run privately, and
// that service would ignore our config. v1 has no such flag and rejects it.
// Help text is the direct signal; the major version backs it up in case help changes.
export function supportsStandalone(executable: string) {
  const help = spawnSync(executable, ["--help"], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (/--standalone/.test(`${help.stdout ?? ""}${help.stderr ?? ""}`))
    return true;
  const out = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 10000,
  });
  const major = Number(/(\d+)\.\d+/.exec(out.stdout ?? "")?.[1]);
  return major >= 2;
}

// The flag goes after a subcommand ("run --standalone ..."), or first for the interactive screen.
export function withStandalone(forwarded: string[]) {
  if (forwarded.length && !forwarded[0].startsWith("-")) {
    return [forwarded[0], "--standalone", ...forwarded.slice(1)];
  }
  return ["--standalone", ...forwarded];
}
