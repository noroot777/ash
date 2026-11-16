// 开工点里「不在目标分支历史上」的那部分代码是谁带来的，其中哪些已经进了任务分支合进来的那段目标分支。
//
// task-change-scope.ts 只在一种情形下来问：任务分支合过目标分支，而开工点不在合进来的那一段里 ——
// 开工点带着别处的代码。带来的人有两种：按前置开工的每条前置（`task_prerequisites.inherited_commit`），
// 或单父继承的那个父任务（`baseTaskId`）。都不是（比如基线选了另一条分支）就整个开工点照旧算进基准。
//
// 「进没进」的判据是 task-branch-plan.ts 的 `versionDelivery`，跟验收依赖、前置起点问的是同一件事，
// 只是对着的不是目标分支的头，而是**任务分支里已经合进来的那一段**：前置合入了目标分支、下游还没把那一段
// 合进来时，前置的代码在下游这里仍然只来自开工点。
//
// 给回去两样。`pending` 是「基准里还要从开工点这一侧补上的那几版」：
//   · 带来的全都进去了 → 空的：合进来的那段目标分支已经包含它们，开工点不再另算一份。
//     压缩合入、调整历史后合入时两边是内容相同的不同提交，再合一遍轻则重复、重则冲突，
//     还会把目标分支后来对同一处的修改算成下游的改动；
//   · 一条都没进 → 开工点本身（单父时是继承到的那一版，下游后来又合过父分支的话它比开工点新）；
//   · 进了一部分 → 只补还没进的那几条前置各自交出的那一版。
// `carried` 是别人交给它的每一版，进没进都算：提交清单要把从它们走得到的提交一并排除
// （压缩合入之后，那些提交从目标分支走不到，却仍然不是这条任务做的）。
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { taskBranchReceipts, taskPrerequisites, tasks } from "./db/schema.js";
import { inheritedParentCommit, versionDelivery } from "./task-branch-plan.js";
import { remembered } from "./task-change-scope.js";

// 判定要跑好几次 git，而验收台和产物面板在轮询：同一组提交号、同一份库里的事实，答案不变。
export type StartSide = { pending: string[]; carried: string[] };
const sides = remembered<StartSide>();

export async function startSideOf(repo: string, taskId: string, head: string, start: string, merged: string[]): Promise<StartSide> {
  const whole: StartSide = { pending: [start], carried: [] };
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return whole;
  const edges = await db.select().from(taskPrerequisites)
    .where(and(eq(taskPrerequisites.taskId, taskId), isNotNull(taskPrerequisites.inheritedCommit)));
  const givers = edges.length
    ? edges.map((edge) => ({ id: edge.prerequisiteId, inherited: edge.inheritedCommit as string | null }))
    : task.baseTaskId ? [{ id: task.baseTaskId, inherited: null }] : [];
  if (!givers.length) return whole;
  const ids = givers.map((giver) => giver.id);
  const parents = await db.select().from(tasks).where(inArray(tasks.id, ids));
  const receipts = await db.select().from(taskBranchReceipts).where(inArray(taskBranchReceipts.taskId, ids));
  // versionDelivery 读的库内事实都在这里：哪一样变了，记着的答案就作废。
  const facts = JSON.stringify([
    givers,
    parents.map((parent) => [parent.id, parent.acceptedSourceCommit, parent.acceptedBaseCommit, parent.acceptedMergeCommit]).sort(),
    receipts.map((receipt) => [receipt.taskId, receipt.sourceCommit, receipt.mergeCommit]).sort(),
  ]);
  return sides.get([repo, taskId, head, start, ...merged, facts].join("\0"), async () => {
    const pending: string[] = [];
    const carried: string[] = [];
    for (const giver of givers) {
      const parent = parents.find((row) => row.id === giver.id);
      const inherited = giver.inherited ?? await inheritedParentCommit(task, repo, parent) ?? start;
      carried.push(inherited);
      let delivered = false;
      for (const commit of merged) {
        if (await versionDelivery(repo, giver.id, parent, inherited, commit) !== null) { delivered = true; break; }
      }
      if (!delivered) pending.push(inherited);
    }
    // 按前置开工、一条都没进：开工点就是它们合在一起的那一版，整个拿来比逐条重合一遍稳。
    return { pending: edges.length && pending.length === givers.length ? [start] : pending, carried };
  });
}
