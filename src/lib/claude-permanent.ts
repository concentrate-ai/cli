import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { prepareClaudeContext } from "./claude-context.js";
import { CnError } from "./errors.js";
import { isRecord } from "./validation.js";
import {
  readConfigFile,
  type ConfigChange,
  type ConfigPlan,
} from "./native-config-store.js";
import type { Environment, Model } from "./types.js";

export const PERMANENT_CLAUDE_PLUGIN = "cn-context@concentrate-cn";

// Ask this installed Claude release to create its plugin registration in an
// isolated directory. Apply only that plugin's entries to the user's registry;
// never hand-maintain the client's installed-plugin schema or invoke its
// installer against live user settings.
export function permanentClaudePlugin(
  executable: string,
  available: Model[],
  config: string,
  artifact: string,
  env: Environment,
): ConfigPlan[] {
  const stage = fs.mkdtempSync(
    path.join(os.tmpdir(), "cn-claude-native-plugin-"),
  );
  const prepared = prepareClaudeContext({
    executable,
    available,
    env: {},
    persistent: true,
  });
  try {
    const market = path.join(stage, "market");
    fs.mkdirSync(path.join(market, ".claude-plugin"), { recursive: true });
    fs.cpSync(prepared.directory, path.join(market, "context"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(market, ".claude-plugin/marketplace.json"),
      JSON.stringify({
        name: "concentrate-cn",
        owner: { name: "Concentrate AI" },
        plugins: [
          {
            name: "cn-context",
            source: "./context",
            description: "Synchronize selected-model capabilities",
          },
        ],
      }),
    );
    const stagedConfig = path.join(stage, "config");
    const installed = spawnSync(
      executable,
      [
        "plugin",
        "install",
        "cn-context",
        "--marketplace",
        market,
        "--scope",
        "user",
        "--json",
      ],
      {
        env: {
          PATH: env.PATH,
          HOME: path.join(stage, "home"),
          CLAUDE_CONFIG_DIR: stagedConfig,
          ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
        },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    if (installed.error || installed.status !== 0)
      throw new CnError(
        "Claude could not prepare the persistent context plugin. No user settings were changed.",
      );
    const translate = (value: unknown): unknown => {
      if (typeof value === "string") return value.replaceAll(stage, artifact);
      if (Array.isArray(value)) return value.map(translate);
      if (isRecord(value))
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, translate(item)]),
        );
      return value;
    };
    const plans: ConfigPlan[] = [];
    for (const [name, key] of [
      ["installed_plugins.json", PERMANENT_CLAUDE_PLUGIN],
      ["known_marketplaces.json", "concentrate-cn"],
    ]) {
      const file = path.join(config, "plugins", name);
      const source: unknown = JSON.parse(
        fs.readFileSync(path.join(stagedConfig, "plugins", name), "utf8"),
      );
      const sourceRoot =
        name === "installed_plugins.json" && isRecord(source)
          ? source.plugins
          : source;
      if (!isRecord(sourceRoot) || !sourceRoot[key])
        throw new CnError(
          "This Claude version's plugin registration format is not supported. No user settings were changed.",
        );
      const changes: ConfigChange[] = [
        {
          key: name === "installed_plugins.json" ? ["plugins", key] : [key],
          value: translate(sourceRoot[key]),
        },
      ];
      if (name === "installed_plugins.json") {
        const existing: unknown = JSON.parse(readConfigFile(file) || "{}");
        if (
          !isRecord(source) ||
          (isRecord(existing) &&
            existing.version !== undefined &&
            existing.version !== source.version)
        )
          throw new CnError(
            "Claude's plugin registry version differs from this client. Update Claude and retry.",
          );
        changes.unshift({
          key: ["version"],
          value: source.version,
          retainOnEditedFile: true,
        });
      }
      plans.push({ file, format: "json", changes });
    }
    const collect = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) collect(file);
        else if (entry.isFile())
          plans.push({
            file: path.join(artifact, path.relative(stage, file)),
            format: "text",
            changes: [
              { key: ["content"], value: fs.readFileSync(file, "utf8") },
            ],
          });
        else
          throw new CnError(
            "Claude generated an unexpected plugin artifact. No user settings were changed.",
          );
      }
    };
    collect(market);
    collect(path.join(stagedConfig, "plugins", "cache"));
    return plans;
  } finally {
    prepared.cleanup();
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
