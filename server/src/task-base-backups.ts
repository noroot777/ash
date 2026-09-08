import { execFileText as exec } from "./exec.js";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks, taskBranchReceipts } from "./db/schema.js";
import { resolveWorktreeBranchName } from "./git.js";
import { baseUpdateBackupPrefix, containsCommit, inheritedParentCommit } from "./task-branch-plan.js";

export async function readBaseUpdateBackups(repo: string, taskId: string): Promise<{ ref: string; commit: string }[]> {
  const prefix = baseUpdateBackupPrefix(taskId);
  const { stdout } = await exec("git", ["-C", repo, "for-each-ref", "--format=%(refname) %(objectname) %(objecttype)", prefix], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim().split("\n").flatMap(line => {
    const [ref, commit, type] = line.split(" ");
    return ref?.startsWith(prefix) && type === "commit" ? [{ ref, commit }] : [];
  });
}

export async function retainBaseUpdateBackups(repo: string, taskId: string, keep: string[]): Promise<string> {
  const retained = new Set(keep);
  try {
    const backups = await readBaseUpdateBackups(repo, taskId);
    const children = (await db.select().from(tasks).where(eq(tasks.baseTaskId, taskId))).filter(child => child.stage !== "accepted");
    const parent = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    const receipts = children.length ? await db.select().from(taskBranchReceipts).where(eq(taskBranchReceipts.taskId, taskId)) : [];
    const parentBranch = children.length ? await resolveWorktreeBranchName(repo, taskId) : "";
    for (const child of children) {
      const inherited = await inheritedParentCommit(child, repo, parent);
      if (!inherited || child.mergeTargetBranch && await containsCommit(repo, inherited, child.mergeTargetBranch)) continue;
      for (const receipt of receipts) {
        const sourceRefs = backups.filter(backup => backup.commit === receipt.sourceCommit);
        if (!sourceRefs.length || !await containsCommit(repo, inherited, receipt.sourceCommit)) continue;
        if (child.mergeTargetBranch && !await containsCommit(repo, receipt.mergeCommit, child.mergeTargetBranch)
          && !await containsCommit(repo, receipt.mergeCommit, parentBranch)) continue;
        // 下游仍用这条映射时，旧 source 对象本身也是证据；仅保留一个 ref 即可防止 GC。
        retained.add((sourceRefs.find(backup => retained.has(backup.ref)) ?? sourceRefs[0]).ref);
        break;
      }
    }
    for (const backup of backups) {
      if (!retained.has(backup.ref)) await exec("git", ["-C", repo, "update-ref", "-d", backup.ref, backup.commit]);
    }
    return "";
  } catch { return "较早的基线备份未全部清理，现存备份仍可读取。"; }
}
