// 开工点里「不在目标分支历史上」的那部分代码是谁带来的，其中哪些已经进了任务分支合进来的那段目标分支。
//
// task-change-scope.ts 只在一种情形下来问：任务分支合过目标分支，而开工点不在合进来的那一段里 ——
// 开工点带着别处的代码。带来的人有两种：按前置开工的每条前置（`task_prerequisites.inherited_commit`），
// 或单父继承的那个父任务（`baseTaskId`）。都不是（比如基线选了另一条分支）就整个开工点照旧算进基准。
//
// 每个来源交来的不只开工时那一版：下游后来再合一次它的分支，就又拿到更新的一版。这些版本从**留得住的
// 记录**里认 —— 来源验收时记下的那一版（`acceptedSourceCommit`）、验收回执里的那一版、还在的话加上它的
// 分支头 —— 各自和任务分支的共同祖先里、比开工时那一版新的，就是后来交来的。不能只靠来源的分支：
// 验收清理会删掉它，那之后「后来交来的」就认不出来，那几条提交会被算成下游自己的。
//
// 「进没进」的判据是 task-branch-plan.ts 的 `versionDelivery`，跟验收依赖、前置起点问的是同一件事，
// 只是对着的不是目标分支的头，而是**任务分支里已经合进来的那一段**：前置合入了目标分支、下游还没把那一段
// 合进来时，前置的代码在下游这里仍然只来自开工点。问的是每个来源交来的**最新**那一版。
//
// 给回去两样。`pending` 是「基准里还要从开工点这一侧补上的那几版」：
//   · 带来的全都进去了 → 空的：合进来的那段目标分支已经包含它们，开工点不再另算一份。
//     压缩合入、调整历史后合入时两边是内容相同的不同提交，再合一遍轻则重复、重则冲突，
//     还会把目标分支后来对同一处的修改算成下游的改动；
//   · 一条都没进 → 开工点，连同后来交来的更新版本（合基准时被包含的那一版自然略过）；
//   · 进了一部分 → 只补还没进的那几个来源各自最新的那一版。
// `carried` 是别人交给它的每一版，进没进都算：提交清单要把从它们走得到的提交一并排除
// （压缩合入之后，那些提交从目标分支走不到，却仍然不是这条任务做的）。
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { taskBranchReceipts, taskPrerequisites, tasks } from "./db/schema.js";
import { execFileText as exec } from "./exec.js";
import { resolveWorktreeBranchName } from "./git.js";
import { versionDelivery } from "./task-branch-plan.js";
import { commitOf, contains, remembered } from "./task-change-scope.js";

// 判定要跑好几次 git，而验收台和产物面板在轮询：同一组提交号、同一份库里的事实，答案不变。
export type StartSide = { pending: string[]; carried: string[] };
const sides = remembered<StartSide>();

/** 来源的某一版记录和任务分支的共同祖先（可以不止一个）。 */
const commonWith = async (repo: string, recorded: string, head: string): Promise<string[]> =>
  exec("git", ["-C", repo, "merge-base", "--all", recorded, head]).then((out) => out.stdout.split("\n").filter(Boolean), (error) => {
    if ((error as { code?: unknown }).code === 1) return [];
    throw error;
  });

export async function startSideOf(repo: string, taskId: string, head: string, start: string, merged: string[]): Promise<StartSide> {
  const whole: StartSide = { pending: [start], carried: [] };
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return whole;
  const edges = await db.select().from(taskPrerequisites)
    .where(and(eq(taskPrerequisites.taskId, taskId), isNotNull(taskPrerequisites.inheritedCommit)));
  // `given` = 开工时它交来的那一版；单父继承时开工点本身就是父任务的那一版。
  const givers = edges.length
    ? edges.map((edge) => ({ id: edge.prerequisiteId, given: edge.inheritedCommit! }))
    : task.baseTaskId ? [{ id: task.baseTaskId, given: start }] : [];
  if (!givers.length) return whole;
  const ids = givers.map((giver) => giver.id);
  const parents = await db.select().from(tasks).where(inArray(tasks.id, ids));
  const receipts = await db.select().from(taskBranchReceipts).where(inArray(taskBranchReceipts.taskId, ids));
  // 每个来源留下的各版记录。分支头每次现读：它在不在、指着哪，都是答案的一部分，要进下面那把键。
  const records = await Promise.all(givers.map(async (giver) => [...new Set([
    await commitOf(repo, `refs/heads/${await resolveWorktreeBranchName(repo, giver.id)}`),
    parents.find((row) => row.id === giver.id)?.acceptedSourceCommit,
    ...receipts.filter((receipt) => receipt.taskId === giver.id).map((receipt) => receipt.sourceCommit),
  ].filter((commit): commit is string => !!commit))]));
  // versionDelivery 读的库内事实也都在这里：哪一样变了，记着的答案就作废。
  const facts = JSON.stringify([
    givers, records,
    parents.map((parent) => [parent.id, parent.acceptedSourceCommit, parent.acceptedBaseCommit, parent.acceptedMergeCommit]).sort(),
    receipts.map((receipt) => [receipt.taskId, receipt.sourceCommit, receipt.mergeCommit]).sort(),
  ]);
  return sides.get([repo, taskId, head, start, ...merged, facts].join("\0"), async () => {
    const pending: string[] = [];
    const carried: string[] = [];
    let delivered = false;
    for (const [index, giver] of givers.entries()) {
      const parent = parents.find((row) => row.id === giver.id);
      const versions = [giver.given];
      for (const recorded of records[index]!) {
        // 读不到的记录（压缩合入后被仓库整理收走）帮不上忙；把这条任务整个收了进去的那一版
        // （旧的父子关系里子任务直接合入父分支）不是它交来的，是它收走的。
        if (!await commitOf(repo, recorded) || await contains(repo, head, recorded)) continue;
        for (const common of await commonWith(repo, recorded, head)) {
          if (!versions.includes(common) && await contains(repo, giver.given, common)) versions.push(common);
        }
      }
      carried.push(...versions);
      for (const version of versions) {
        let newest = true;
        for (const other of versions) if (other !== version && await contains(repo, version, other)) { newest = false; break; }
        if (!newest) continue;
        let inside = false;
        for (const commit of merged) {
          if (await versionDelivery(repo, giver.id, parent, version, commit) !== null) { inside = true; break; }
        }
        if (inside) delivered = true;
        else pending.push(version);
      }
    }
    // 一条都没进：开工点就是它们开工时合在一起的那一版，整个拿来比逐条重合一遍稳。
    return { pending: delivered ? pending : [start, ...pending], carried: [...new Set(carried)] };
  });
}
