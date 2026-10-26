import fs from "node:fs";
import path from "node:path";

export function which(command: string, searchPath = process.env.PATH ?? "") {
  for (const directory of searchPath
    .split(path.delimiter)
    .filter(path.isAbsolute)) {
    const candidate = path.join(directory, command);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Not executable here; keep looking.
    }
  }
  return null;
}
