import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig, type ConfigFormat } from "./config-formats.js";
import { record } from "./validation.js";
import type { Environment } from "./types.js";

// Header names are case-insensitive. Keep user-supplied values and spelling.
function mergeHeaders(...sources: unknown[]) {
  const headers: Record<string, string> = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(record(source))) {
      if (typeof value !== "string") continue;
      const previous = Object.keys(headers).find(
        (key) => key.toLowerCase() === name.toLowerCase(),
      );
      if (previous) delete headers[previous];
      headers[name] = value;
    }
  }
  return headers;
}

export function appHeaders(app: string, ...sources: unknown[]) {
  const headers = mergeHeaders(...sources);
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "x-app"))
    headers["X-App"] = app;
  return headers;
}

export function configDocument(file: string, format: ConfigFormat = "json") {
  try {
    return parseConfig(fs.readFileSync(file, "utf8"), format);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

// Codex treats subcommand -c lists separately from top-level lists. Keep them
// together so a forwarded override cannot discard cn's connection settings.
export function codexConfigArguments(forwarded: string[]) {
  const overrides: string[] = [];
  const args: string[] = [];
  for (let i = 0; i < forwarded.length; i++) {
    const argument = forwarded[i];
    if (argument === "--") {
      args.push(...forwarded.slice(i));
      break;
    }
    if (
      (argument === "-c" || argument === "--config") &&
      forwarded[i + 1] !== undefined
    )
      overrides.push(forwarded[++i]);
    else if (argument.startsWith("--config="))
      overrides.push(argument.slice(9));
    else if (argument.startsWith("-c=")) overrides.push(argument.slice(3));
    else args.push(argument);
  }
  return { overrides, args };
}

export function codexHeaderConfig(
  provider: string,
  env: Environment,
  forwarded: string[] = [],
) {
  const directory =
    env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex");
  const documents = [
    configDocument(path.join(directory, "config.toml"), "toml"),
  ];
  for (const value of codexConfigArguments(forwarded).overrides) {
    if (
      ["http_headers", "env_http_headers"].some((field) =>
        value.startsWith(`model_providers.${provider}.${field}`),
      )
    ) {
      try {
        documents.push(parseConfig(value, "toml"));
      } catch {
        // Like Codex, accept an unquoted scalar override as a literal string.
        const equals = value.indexOf("=");
        if (equals >= 0)
          documents.push(
            parseConfig(
              `${value.slice(0, equals)}=${JSON.stringify(value.slice(equals + 1))}`,
              "toml",
            ),
          );
      }
    }
  }
  const providers = documents.flatMap((doc) => {
    const configured = record(doc.model_providers);
    return provider === "concentrate"
      ? [record(configured.cn_concentrate), record(configured[provider])]
      : [record(configured[provider])];
  });
  const headers = appHeaders(
    "codex",
    ...providers.map((entry) => entry.http_headers),
  );
  // A header supplied through an environment variable already has an owner.
  const hasStaticApp = providers.some((entry) =>
    Object.keys(record(entry.http_headers)).some(
      (name) => name.toLowerCase() === "x-app",
    ),
  );
  if (
    !hasStaticApp &&
    providers.some((entry) =>
      Object.keys(record(entry.env_http_headers)).some(
        (name) => name.toLowerCase() === "x-app",
      ),
    )
  )
    delete headers["X-App"];
  return {
    http_headers: headers,
    env_http_headers: mergeHeaders(
      ...providers.map((entry) => entry.env_http_headers),
    ),
  };
}

export function codexHeaders(
  provider: string,
  env: Environment,
  forwarded: string[] = [],
) {
  return codexHeaderConfig(provider, env, forwarded).http_headers;
}

export function openCodeHeaders(
  env: Environment,
  modern: boolean,
  session = true,
) {
  const root = path.join(
    env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config"),
    "opencode",
  );
  const files = [
    path.join(root, "opencode.json"),
    path.join(root, "opencode.jsonc"),
    ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : []),
    ...(session
      ? [
          path.join(process.cwd(), "opencode.json"),
          path.join(process.cwd(), "opencode.jsonc"),
        ]
      : []),
  ];
  const documents = files.map((file) => configDocument(file));
  if (session && env.OPENCODE_CONFIG_CONTENT)
    documents.push(parseConfig(env.OPENCODE_CONFIG_CONTENT, "json"));
  return appHeaders(
    "opencode",
    ...documents.map((doc) => {
      const provider = record(
        record(doc[modern ? "providers" : "provider"]).concentrate,
      );
      return modern ? provider.headers : record(provider.options).headers;
    }),
  );
}
