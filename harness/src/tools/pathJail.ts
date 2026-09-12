import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export class PathJailError extends Error {}

/**
 * Resolves `relativePath` against `repoRoot` and guarantees the result stays inside it.
 * Never trust a path from the reasoning loop without going through this first (NFR2) —
 * this is the harness's one enforcement point for the repo-root jail, so every tool
 * implementation must call it before touching the filesystem.
 */
export function resolveSafePath(repoRoot: string, relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new PathJailError("path must be a non-empty string");
  }
  if (relativePath.includes("\0")) {
    throw new PathJailError("path contains a null byte");
  }
  if (isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath) || relativePath.startsWith("\\\\")) {
    throw new PathJailError("path must be relative to the repository root, not absolute");
  }

  const canonicalRoot = realpathSync(repoRoot);
  const resolved = resolve(canonicalRoot, relativePath);

  if (!isInside(canonicalRoot, resolved)) {
    throw new PathJailError(`path escapes the repository root: ${relativePath}`);
  }

  // Re-check via realpath so a symlink inside the repo can't point outside it.
  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    if (!isInside(canonicalRoot, real)) {
      throw new PathJailError(`path resolves (via symlink) outside the repository root: ${relativePath}`);
    }
    return real;
  }

  return resolved;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}
