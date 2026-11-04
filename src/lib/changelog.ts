import { readFileSync } from "node:fs";
import { isNewer } from "./cli/update.js";

// CHANGELOG.md ships beside package.json. Each release is a "## x.y.z" section.
export function readChangelog(): string | null {
  try {
    return readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
  } catch {
    return null;
  }
}

export function changelogSections(text: string) {
  const sections: { version: string; body: string }[] = [];
  for (const block of text.split(/^## /m).slice(1)) {
    const [heading, ...lines] = block.split("\n");
    const version = heading.trim().split(/\s/)[0];
    if (/^\d+\.\d+\.\d+$/.test(version))
      sections.push({ version, body: lines.join("\n").trim() });
  }
  return sections;
}

// The notes for every release newer than `since`, newest first.
export function changesSince(text: string, since?: string) {
  return changelogSections(text)
    .filter((section) => !since || isNewer(section.version, since))
    .map((section) => `${section.version}\n${section.body}`)
    .join("\n\n");
}
