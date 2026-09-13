import { createTwoFilesPatch } from "diff";
import type { WritePlan } from "./writePlan.js";

/** Renders a plan as a standard unified diff (git-style `---`/`+++`/`@@` headers) for terminal display. */
export function buildDiffPreview(plan: WritePlan): string {
  const oldLabel = plan.oldContent === null ? "/dev/null" : `a/${plan.relPath}`;
  const newLabel = `b/${plan.relPath}`;
  return createTwoFilesPatch(oldLabel, newLabel, plan.oldContent ?? "", plan.newContent, undefined, undefined, {
    context: 3,
  });
}
