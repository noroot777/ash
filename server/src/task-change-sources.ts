// 来源任务（按前置开工的每条前置、单父继承的那个父任务）的验收记录说了算的两件事。
// task-change-scope.ts 在任务分支合过目标分支时来问。
//
// 一、开工点里别人带来的那部分代码，哪些已经进了任务分支合进来的那段目标分支（`pending` = 还没进、
// 基准里要从开工点这一侧补上的那几版）。认的是**开工时冻结的那一版**：前置是
// `task_prerequisites.inherited_commit`，单父继承是开工点本身。判据是 task-branch-plan.ts 的
// `versionDelivery`，跟验收依赖、前置起点问的是同一件事，只是对着的不是目标分支的头，而是任务分支里
// 已经合进来的那一段 —— 前置合入了目标分支、下游还没把那一段合进来时，前置的代码在下游这里仍然只来自开工点。
//   · 带来的全都进去了 → 空的：合进来的那段目标分支已经包含它们，开工点不再另算一份。
//     压缩合入、调整历史后合入时两边是内容相同的不同提交，再合一遍轻则重复、重则冲突，
//     还会把目标分支后来对同一处的修改算成下游的改动；
//   · 按前置开工、一条都没进 → 开工点本身；
//   · 进了一部分 → 只补还没进的那几条前置各自交出的那一版。
//   来源都不是这两种（比如基线选了另一条分支）就整个开工点照旧算进基准。
//
// 二、来源任务验收时记下的那一版里，哪些的合入已经在那段目标分支里（`landed`）。提交清单要把从它们
// 走得到的提交一并排除：压缩合入之后那些提交从目标分支走不到，内容却已经在目标分支上了。
//
// 两件事都只读库里记下的提交号，**不读来源任务的分支** —— 它在不在、指着哪，都不影响结果；
// 也不从共同祖先去认「来源后来又交来的」（为什么不认，见 task-change-scope.ts 文件头）。
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { taskBranchReceipts, taskPrerequisites, tasks } from "./db/schema.js";
import { versionDelivery } from "./task-branch-plan.js";
import { commitOf, contains, remembered } from "./task-change-scope.js";

// 判定要跑好几次 git，而验收台和产物面板在轮询：同一组提交号、同一份库里的事实，答案不变。
export type StartSide = { pending: string[]; landed: string[] };
const sides = remembered<StartSide>();

export async function startSideOf(repo: string, taskId: string, start: string | null, merged: string[]): Promise<StartSide> {
  const whole: StartSide = { pending: start ? [start] : [], landed: [] };
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return whole;
  const edges = await db.select().from(taskPrerequisites)
    .where(and(eq(taskPrerequisites.taskId, taskId), isNotNull(taskPrerequisites.inheritedCommit)));
  // `given` = 开工时它交来的那一版；单父继承时开工点本身就是父任务的那一版。
  const givers = edges.length
    ? edges.map((edge) => ({ id: edge.prerequisiteId, given: edge.inheritedCommit! }))
    : task.baseTaskId && start ? [{ id: task.baseTaskId, given: start }] : [];
  if (!givers.length) return whole;
  const ids = givers.map((giver) => giver.id);
  const parents = await db.select().from(tasks).where(inArray(tasks.id, ids));
  const receipts = await db.select().from(taskBranchReceipts).where(inArray(taskBranchReceipts.taskId, ids));
  // 用到的库内事实都在这里：哪一样变了，记着的答案就作废。
  const facts = JSON.stringify([
    givers,
    parents.map((parent) => [parent.id, parent.acceptedSourceCommit, parent.acceptedBaseCommit, parent.acceptedMergeCommit]).sort(),
    receipts.map((receipt) => [receipt.taskId, receipt.sourceCommit, receipt.mergeCommit]).sort(),
  ]);
  return sides.get([repo, taskId, start ?? "", ...merged, facts].join("\0"), async () => {
    const pending: string[] = [];
    for (const giver of givers) {
      const parent = parents.find((row) => row.id === giver.id);
      let delivered = false;
      for (const commit of merged) {
        if (await versionDelivery(repo, giver.id, parent, giver.given, commit) !== null) { delivered = true; break; }
      }
      if (!delivered) pending.push(giver.given);
    }
    const landed: string[] = [];
    // 读不到的那一版（压缩合入后被仓库整理收走）从任务分支也走不到，略过不影响清单。
    const land = async (source: string | null, merge: string | null) => {
      if (!source || !merge || landed.includes(source) || !await commitOf(repo, source) || !await commitOf(repo, merge)) return;
      for (const commit of merged) if (await contains(repo, merge, commit)) { landed.push(source); return; }
    };
    for (const parent of parents) await land(parent.acceptedSourceCommit, parent.acceptedMergeCommit);
    for (const receipt of receipts) await land(receipt.sourceCommit, receipt.mergeCommit);
    // 按前置开工、一条都没进：开工点就是它们合在一起的那一版，整个拿来比逐条重合一遍稳。
    return { pending: edges.length && start && pending.length === givers.length ? [start] : pending, landed };
  });
}
