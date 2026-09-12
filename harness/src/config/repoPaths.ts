import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Walks upward from `startDir` looking for the DevAgent repo root, identified by the
 * presence of both `schemas/envelope.schema.json` and `reasoning/pyproject.toml`.
 * Works regardless of whether the caller is running from harness/src (dev, via tsx)
 * or harness/dist (built), since it searches rather than assuming a fixed depth.
 */
export function findRepoRoot(startDir: string, maxLevels = 8): string {
  let dir = startDir;
  for (let i = 0; i < maxLevels; i++) {
    const hasSchemas = existsSync(join(dir, "schemas", "envelope.schema.json"));
    const hasReasoning = existsSync(join(dir, "reasoning", "pyproject.toml"));
    if (hasSchemas && hasReasoning) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate DevAgent repo root starting from ${startDir}`);
}
