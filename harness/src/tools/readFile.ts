import { readFileSync, statSync } from "node:fs";
import { resolveSafePath } from "./pathJail.js";
import { ToolExecutionError } from "./errors.js";

const MAX_BYTES = 256 * 1024;

export interface ReadFileArgs {
  path: string;
}

export interface ReadFileResult {
  content: string;
  truncated: boolean;
  totalBytes: number;
}

export async function readFile(repoRoot: string, args: ReadFileArgs): Promise<ReadFileResult> {
  const safePath = resolveSafePath(repoRoot, args.path);
  const stat = statSync(safePath, { throwIfNoEntry: false });
  if (!stat) {
    throw new ToolExecutionError("not_found", `no such file: ${args.path}`);
  }
  if (stat.isDirectory()) {
    throw new ToolExecutionError("is_a_directory", `${args.path} is a directory, not a file`);
  }
  const buf = readFileSync(safePath);
  const truncated = buf.length > MAX_BYTES;
  const content = buf.subarray(0, MAX_BYTES).toString("utf8");
  return { content, truncated, totalBytes: buf.length };
}
