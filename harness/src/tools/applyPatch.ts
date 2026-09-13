import { planApplyPatch, commitWrite, type ApplyPatchArgs, type CommitResult } from "./writePlan.js";

export type { ApplyPatchArgs };

export async function applyPatch(repoRoot: string, args: ApplyPatchArgs): Promise<CommitResult> {
  return commitWrite(planApplyPatch(repoRoot, args));
}
