import { readdirSync, statSync } from "node:fs";
import { resolveSafePath } from "./pathJail.js";
import { ToolExecutionError } from "./errors.js";

export interface ListDirArgs {
  path: string;
}

export interface DirEntry {
  name: string;
  type: "file" | "dir";
}

export interface ListDirResult {
  entries: DirEntry[];
}

export async function listDir(repoRoot: string, args: ListDirArgs): Promise<ListDirResult> {
  const safePath = resolveSafePath(repoRoot, args.path);
  const stat = statSync(safePath, { throwIfNoEntry: false });
  if (!stat) {
    throw new ToolExecutionError("not_found", `no such directory: ${args.path}`);
  }
  if (!stat.isDirectory()) {
    throw new ToolExecutionError("not_a_directory", `${args.path} is not a directory`);
  }

  const entries: DirEntry[] = readdirSync(safePath, { withFileTypes: true })
    .map((d) => ({ name: d.name, type: (d.isDirectory() ? "dir" : "file") as "dir" | "file" }))
    .sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));

  return { entries };
}
