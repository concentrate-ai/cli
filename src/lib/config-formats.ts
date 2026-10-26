import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  type ParseError,
} from "jsonc-parser";
import { isRecord } from "./validation.js";
import { CnError } from "./errors.js";

export type ConfigFormat = "json" | "toml" | "text";
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
        : parseJsonc(text || "{}", errors, { allowTrailingComma: true });
    if (errors.length || !isRecord(result))
      throw new Error("Invalid configuration");
    return result;
  } catch {
    throw new CnError(
      `The existing ${format.toUpperCase()} configuration is invalid; it was left unchanged.`,
    );
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
      text || "{}\n",
      modify(text || "{}\n", key, value, {
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
  return stringifyToml(doc);
}
