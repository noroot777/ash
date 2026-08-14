import { continueWhenIdle } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";

// 验收撞冲突,是整条流程里唯一一处「后端做不下去、但 agent 做得了」的岔口:merge 只
// 会 abort 并如实报告(绝不强合),而没人去解冲突,任务就永远停在 awaiting_acceptance。
// 这里把来源任务叫醒,让它在**自己的分支**上把目标分支合进来解掉,解完用户再点验收
// 就退化成 fast-forward,仍然走原来那条确定性后端路径。
export type ConflictHandoff = { notified: boolean; message: string };

// 交接分两步:验收锁**内**只登记(handOffConflict),真正的唤醒等锁释放之后才发
// (flushConflictHandoff)。锁内直接叫是叫不动的 —— continueTask 一进门就查
// isAcceptingTask,看见验收在进行中就静默退避返回 false,而这里当时是 `void` 掉的
// fire-and-forget,退避连个响都没有:时间线上写着「已叫醒该任务去解冲突」,任务却
// 一动没动(2026-08-14 现场:用户对着这句话干等了一早上)。
// 登记态按 taskId 存:同一个任务的验收本来就被 acceptance-lock 串成一次一个。
type PendingHandoff = { prompt: string; sourceBranch: string; targetBranch: string };
const pending = new Map<string, PendingHandoff>();

// 走**不带 system** 的 continueTask:这一轮是「验收之后的对话」,不是重跑任务 ——
// followUpFrom 会护住它原来的终态,不会因为这一轮没调 complete_task 把 done 打成 failed。
const CONFLICT_PROMPT = (p: {
  sourceBranch: string;
  targetBranch: string;
  conflictFiles: string[];
}) =>
  `【验收未通过 · 需要你解冲突】\n` +
  `用户点了「验收通过」，后端把你的任务分支 \`${p.sourceBranch}\` 合并到目标分支 \`${p.targetBranch}\` 时发生冲突，` +
  `已经安全回滚（merge --abort），目标分支一个字没动。\n\n` +
  `冲突文件：\n${p.conflictFiles.map((f) => `- ${f}`).join("\n")}\n\n` +
  `请你来解决：\n` +
  `1. 在你自己的工作目录里 \`git merge ${p.targetBranch}\`（把目标分支合进任务分支），逐个解掉冲突并提交；\n` +
  `2. 解完自查一遍（构建 / 类型检查 / 必要的真实验证），确认既没破坏你这次的改动，也没覆盖别人的改动；\n` +
  `3. **不要动目标分支**：不要 checkout 或合并到目标分支，不要删 worktree / 分支——这些一律由验收动作统一做；\n` +
  `4. 完成后告诉用户可以重新点验收（那时会是 fast-forward）。\n\n` +
  `如果冲突需要产品决策（两边改动语义打架、你判断不了该留谁），用 \`ask_question\` 问用户——` +
  `但**提问前先 \`git merge --abort\` 把工作区收干净**，拿到答复后重新 merge 再解。` +
  `半合并状态（冲突标记还在、索引是 UU）留在那里会绊倒后续的任何一步：下一轮 agent 在冲突态里开工、` +
  `验收清理时 \`git worktree remove\` 因工作区脏而失败。`;

export async function handOffConflict(
  task: { id: string; title: string },
  merge: { reason?: string; sourceBranch?: string; targetBranch?: string | null; conflictFiles?: string[] },
): Promise<ConflictHandoff | null> {
  // 只接管真冲突。脏工作区、分支缺失这类是环境/用户侧问题,叫醒 agent 也解决不了。
  if (merge.reason !== "merge_conflict") return null;
  const files = merge.conflictFiles ?? [];
  const sourceBranch = merge.sourceBranch ?? "";
  const targetBranch = merge.targetBranch ?? "";
  if (!files.length || !sourceBranch || !targetBranch) return null;

  const prompt = CONFLICT_PROMPT({ sourceBranch, targetBranch, conflictFiles: files });
  pending.set(task.id, { prompt, sourceBranch, targetBranch });
  const message = `已叫醒该任务去解冲突：它会在 ${sourceBranch} 上合并 ${targetBranch} 并解决 ${files.length} 个冲突文件，完成后重新点验收即可（届时是 fast-forward）。`;
  await appendTaskTimeline(task.id, `冲突交接：${message}`);
  return { notified: true, message };
}

/**
 * 验收锁释放之后调用:把登记好的交接真正发出去。**必须在 endAccepting 之后**,否则
 * continueTask 会因为验收互斥静默退避(见上面的 pending 注释)。
 *
 * 同步返回:唤醒本身是异步的,验收请求不能挂在整轮上等。投递失败(回合被抢占、启动
 * 抛错)一律写进时间线 —— 这条路径唯一的失败模式就是「没人知道它没醒」。
 */
export function flushConflictHandoff(taskId: string): void {
  const plan = pending.get(taskId);
  if (!plan) return;
  pending.delete(taskId);
  // byBackend：占真人回合，但字是后端写的 —— 别混进「我发的追问」里。
  continueWhenIdle(taskId, plan.prompt, { byBackend: true }, async (why) => {
    await appendTaskTimeline(
      taskId,
      `冲突交接失败：没能叫醒该任务解冲突（${why}）。请手动点运行或直接回复它，` +
        `让它在 ${plan.sourceBranch} 上 \`git merge ${plan.targetBranch}\` 解掉冲突后再点验收。`,
    );
  });
}
