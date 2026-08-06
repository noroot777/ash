import { continueTask } from "./orchestrator.js";
import { appendTaskTimeline } from "./task-timeline.js";

// 验收撞冲突,是整条流程里唯一一处「后端做不下去、但 agent 做得了」的岔口:merge 只
// 会 abort 并如实报告(绝不强合),而没人去解冲突,任务就永远停在 awaiting_acceptance。
// 这里把来源任务叫醒,让它在**自己的分支**上把目标分支合进来解掉,解完用户再点验收
// 就退化成 fast-forward,仍然走原来那条确定性后端路径。
export type ConflictHandoff = { notified: boolean; message: string };

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
  try {
    // 不 await:continueTask 会把整个回合跑完,验收请求不能挂在上面等。
    // byBackend：占真人回合，但字是后端写的 —— 别混进「我发的追问」里。
    void continueTask(task.id, prompt, { byBackend: true }).catch(async (err) => {
      await appendTaskTimeline(
        task.id,
        `冲突交接失败：唤醒该任务解冲突时出错（${err instanceof Error ? err.message : String(err)}），请手动处理。`,
      );
    });
  } catch (err) {
    const message = `唤醒失败：${err instanceof Error ? err.message : String(err)}`;
    await appendTaskTimeline(task.id, `冲突交接失败：${message}`);
    return { notified: false, message };
  }
  const message = `已叫醒该任务去解冲突：它会在 ${sourceBranch} 上合并 ${targetBranch} 并解决 ${files.length} 个冲突文件，完成后重新点验收即可（届时是 fast-forward）。`;
  await appendTaskTimeline(task.id, `冲突交接：${message}`);
  return { notified: true, message };
}
