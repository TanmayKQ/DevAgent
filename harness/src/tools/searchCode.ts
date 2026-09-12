import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { resolveSafePath } from "./pathJail.js";
import { ToolExecutionError } from "./errors.js";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "venv",
  ".venv",
  "__pycache__",
  ".devagent",
  ".pytest_cache",
]);
const MAX_FILES_SCANNED = 5000;
const MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESULTS = 50;

export interface SearchCodeArgs {
  query: string;
  path?: string;
  maxResults?: number;
}

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

export interface SearchCodeResult {
  matches: SearchMatch[];
  truncated: boolean;
}

export async function searchCode(repoRoot: string, args: SearchCodeArgs): Promise<SearchCodeResult> {
  const startPath = resolveSafePath(repoRoot, args.path ?? ".");
  const stat = statSync(startPath, { throwIfNoEntry: false });
  if (!stat) {
    throw new ToolExecutionError("not_found", `no such path: ${args.path ?? "."}`);
  }

  const maxResults = args.maxResults ?? DEFAULT_MAX_RESULTS;
  const needle = args.query.toLowerCase();
  const matches: SearchMatch[] = [];
  let filesScanned = 0;
  let stoppedEarly = false;

  const limitReached = (): boolean => stoppedEarly || matches.length >= maxResults;

  const walk = (dir: string): void => {
    if (limitReached()) return;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (limitReached()) return;
      if (d.isDirectory()) {
        if (IGNORED_DIRS.has(d.name)) continue;
        walk(join(dir, d.name));
        continue;
      }
      if (!d.isFile()) continue;
      if (filesScanned >= MAX_FILES_SCANNED) {
        stoppedEarly = true;
        return;
      }
      filesScanned++;

      const filePath = join(dir, d.name);
      let fstat;
      try {
        fstat = statSync(filePath);
      } catch {
        continue;
      }
      if (fstat.size > MAX_FILE_BYTES) continue;

      let content: string;
      try {
        content = readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\0")) continue; // heuristic: skip binary files

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push({
            file: relative(repoRoot, filePath).split(sep).join("/"),
            line: i + 1,
            text: lines[i].trim().slice(0, 300),
          });
          if (matches.length >= maxResults) break;
        }
      }
    }
  };

  walk(startPath);
  return { matches, truncated: limitReached() };
}
