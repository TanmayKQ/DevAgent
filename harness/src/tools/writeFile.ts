import { planWriteFile, commitWrite, type WriteFileArgs, type CommitResult } from "./writePlan.js";

export type { WriteFileArgs };

export async function writeFile(repoRoot: string, args: WriteFileArgs): Promise<CommitResult> {
  return commitWrite(planWriteFile(repoRoot, args));
}
