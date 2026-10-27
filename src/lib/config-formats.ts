import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  applyEdits,
  createScanner,
  modify,
  parse as parseJsonc,
  SyntaxKind,
  type ParseError,
} from "jsonc-parser";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "./validation.js";
import { CnError } from "./errors.js";

export type ConfigFormat = "json" | "toml" | "text";

// A file holding only whitespace or comments is an empty JSON document.
const emptyJson = (text: string) => {
  const scanner = createScanner(text, true);
  return scanner.scan() === SyntaxKind.EOF;
};
const jsonBase = (text: string) =>
  emptyJson(text) ? `${text.trimEnd()}${text.trim() ? "\n" : ""}{}\n` : text;
export function parseConfig(
  text: string,
  format: ConfigFormat,
): Record<string, unknown> {
  if (format === "text") return { content: text };
  try {
    const errors: ParseError[] = [];
    const result: unknown =
      format === "toml"
        ? parseToml(text)
        : emptyJson(text)
          ? {}
          : parseJsonc(text, errors, { allowTrailingComma: true });
    if (errors.length || !isRecord(result))
      throw new Error("Invalid configuration");
    return result;
  } catch {
    throw new CnError(
      `The existing ${format.toUpperCase()} configuration is invalid; it was left unchanged.`,
    );
  }
}
const TABLE_HEADER = /^\s*\[/;
const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const sectionName = (line: string) =>
  /^\s*\[(?!\[)\s*([^\]]*?)\s*\]\s*(?:#.*)?$/
    .exec(line)?.[1]
    .replace(/\s*\.\s*/g, ".");

// Edit TOML in place so comments and layout survive. Anything unusual returns
// null and the caller falls back to rewriting the whole file; the result is
// always checked against the document it should produce.
function patchToml(
  text: string,
  key: string[],
  value: unknown,
  expected: Record<string, unknown>,
): string | null {
  if (!key.every((part) => BARE_KEY.test(part))) return null;
  const lines = text.split("\n");
  const firstTable = lines.findIndex((line) => TABLE_HEADER.test(line));
  const topEnd = firstTable === -1 ? lines.length : firstTable;
  const name = key.join(".");
  // Drop the table `name` and everything nested under it.
  const dropSections = () => {
    for (let i = 0; i < lines.length; i += 1) {
      const section = sectionName(lines[i]);
      if (section !== name && !section?.startsWith(`${name}.`)) continue;
      let end = i + 1;
      while (end < lines.length && !TABLE_HEADER.test(lines[end])) end += 1;
      lines.splice(i, end - i);
      i -= 1;
    }
  };
  if (isRecord(value)) {
    dropSections();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length) lines.push("");
    const nested: Record<string, unknown> = {};
    key.reduce<Record<string, unknown>>(
      (target, part, index) =>
        (target[part] = index === key.length - 1 ? value : {}) as Record<
          string,
          unknown
        >,
      nested,
    );
    lines.push(...stringifyToml(nested).trimEnd().split("\n"), "");
  } else if (value === undefined) {
    if (key.length === 1) {
      const at = lines
        .slice(0, topEnd)
        .findIndex((line) => new RegExp(`^\\s*${name}\\s*=`).test(line));
      if (at !== -1) lines.splice(at, 1);
    }
    dropSections();
  } else if (key.length === 1) {
    const line = stringifyToml({ [name]: value }).trimEnd();
    const at = lines
      .slice(0, topEnd)
      .findIndex((entry) => new RegExp(`^\\s*${name}\\s*=`).test(entry));
    if (at !== -1) lines[at] = line;
    else {
      let i = topEnd;
      // Stay above comments that introduce the first table.
      let comments = i;
      while (comments > 0 && /^\s*#/.test(lines[comments - 1])) comments -= 1;
      if (comments > 0) i = comments;
      while (i > 0 && !lines[i - 1].trim()) i -= 1;
      lines.splice(i, 0, line);
      if (lines[i + 1] !== undefined && TABLE_HEADER.test(lines[i + 1]))
        lines.splice(i + 1, 0, "");
    }
  } else return null;
  const patched = lines.join("\n");
  try {
    // Parsed tables and plain objects differ in prototype, so compare as data.
    const plain = (doc: unknown): unknown => JSON.parse(JSON.stringify(doc));
    return isDeepStrictEqual(plain(parseToml(patched)), plain(expected))
      ? patched
      : null;
  } catch {
    return null;
  }
}

export function setConfig(
  text: string,
  format: ConfigFormat,
  key: string[],
  value: unknown,
): string {
  if (format === "text") return String(value ?? "");
  if (format === "json")
    return applyEdits(
      jsonBase(text),
      modify(jsonBase(text), key, value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    );
  const doc = parseConfig(text, format);
  let target = doc;
  for (const part of key.slice(0, -1)) {
    if (!Object.hasOwn(target, part)) target[part] = {};
    const next = target[part];
    if (!isRecord(next))
      throw new CnError(
        `Cannot configure ${key.join(".")}: an existing parent is not a table.`,
      );
    target = next;
  }
  const last = key.at(-1)!;
  if (value === undefined) delete target[last];
  else target[last] = value;
  return patchToml(text, key, value, doc) ?? stringifyToml(doc);
}
