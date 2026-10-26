import { isRecord } from "./validation.js";
import fs from "node:fs";
import path from "node:path";

// Helpers for reading back which model a tool actually used, from its own files.

// Only plain files: a FIFO or device named *.jsonl would block or never end.
export function regularFile(file: string) {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

export function tailLines(file: string, maxBytes = 512 * 1024) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return [];
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

export function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

// When a file was created. Some Linux filesystems report no birth time; mtime stands in.
export function createdMs(file: string) {
  try {
    const stat = fs.lstatSync(file);
    return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
  } catch {
    return 0;
  }
}

export function filesIn(dir: string, suffix: string) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(suffix))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function lastModelInTranscript(
  file: string,
  pick: (entry: Record<string, unknown>) => unknown,
) {
  const lines = tailLines(file);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const entry = parseLine(lines[i]);
    const model = entry && pick(entry);
    if (typeof model === "string" && model && !model.startsWith("<"))
      return model;
  }
  return null;
}
