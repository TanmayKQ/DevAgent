import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveSafePath } from "./pathJail.js";
import { ToolExecutionError } from "./errors.js";

const MAX_WRITE_BYTES = 5 * 1024 * 1024;

export interface WriteFileArgs {
  path: string;
  content: string;
}

export interface ApplyPatchArgs {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * The result of "figuring out what a write would do" without doing it — read by the CLI to
 * build a diff preview before asking for confirmation, then handed to commitWrite() unchanged
 * so the actual write never re-reads or re-validates anything it already computed.
 */
export interface WritePlan {
  toolName: "write_file" | "apply_patch";
  relPath: string;
  safePath: string;
  oldContent: string | null; // null = file does not currently exist
  newContent: string;
  replacements?: number; // apply_patch only
}

export interface CommitResult {
  bytesWritten: number;
  created: boolean;
  replacements?: number;
}

function readExisting(safePath: string, relPath: string): string | null {
  const stat = statSync(safePath, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isDirectory()) {
    throw new ToolExecutionError("is_a_directory", `${relPath} is a directory, not a file`);
  }
  return readFileSync(safePath, "utf8");
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

export function planWriteFile(repoRoot: string, args: WriteFileArgs): WritePlan {
  if (Buffer.byteLength(args.content, "utf8") > MAX_WRITE_BYTES) {
    throw new ToolExecutionError("content_too_large", `content exceeds ${MAX_WRITE_BYTES} bytes`);
  }
  const safePath = resolveSafePath(repoRoot, args.path);
  const oldContent = readExisting(safePath, args.path);
  return { toolName: "write_file", relPath: args.path, safePath, oldContent, newContent: args.content };
}

export function planApplyPatch(repoRoot: string, args: ApplyPatchArgs): WritePlan {
  const safePath = resolveSafePath(repoRoot, args.path);
  const oldContent = readExisting(safePath, args.path);
  if (oldContent === null) {
    throw new ToolExecutionError("not_found", `no such file: ${args.path}`);
  }

  const occurrences = countOccurrences(oldContent, args.old_string);
  if (occurrences === 0) {
    throw new ToolExecutionError("no_match", `old_string not found in ${args.path}`);
  }
  if (!args.replace_all && occurrences > 1) {
    throw new ToolExecutionError(
      "ambiguous_match",
      `old_string matches ${occurrences} times in ${args.path}; pass replace_all:true or include more surrounding context to make it unique`,
    );
  }

  const newContent = args.replace_all
    ? oldContent.split(args.old_string).join(args.new_string)
    : oldContent.replace(args.old_string, args.new_string);

  return {
    toolName: "apply_patch",
    relPath: args.path,
    safePath,
    oldContent,
    newContent,
    replacements: args.replace_all ? occurrences : 1,
  };
}

export function commitWrite(plan: WritePlan): CommitResult {
  mkdirSync(dirname(plan.safePath), { recursive: true });
  writeFileSync(plan.safePath, plan.newContent, "utf8");
  return {
    bytesWritten: Buffer.byteLength(plan.newContent, "utf8"),
    created: plan.oldContent === null,
    ...(plan.replacements !== undefined ? { replacements: plan.replacements } : {}),
  };
}
