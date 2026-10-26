import { readFileSync } from "node:fs";
import { record } from "./validation.js";

export function version(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const value = record(parsed).version;
  if (typeof value !== "string")
    throw new Error("CLI package version is missing");
  return value;
}
