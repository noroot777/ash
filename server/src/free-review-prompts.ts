// 自由工作流的三段 prompt 文案（从 free-workflow.ts 拆出，纯行数拆分）：
// 派审回合、自动修复交接、轮数用尽后的手动修复交接。
import { freeReviewRuns, tasks } from "./db/schema.js";
import { freeReviewEvidenceDir, freeReviewReportPath } from "./free-review-files.js";
import { reviewRequestReference } from "./review-request-context.js";
import { BROWSER_VERIFICATION_POLICY } from "./browser-verification-policy.js";

type TaskRow = typeof tasks.$inferSelect;
type ReviewRunRow = typeof freeReviewRuns.$inferSelect;

export async function freeReviewPrompt(task: TaskRow, run: ReviewRunRow, round: number, repoPath: string): Promise<string> {
  const dir = freeReviewEvidenceDir(task.id, run.id, round);
  const requirements = await reviewRequestReference(task, dir);
  const focus = run.checkMode === "syntax"
    ? "本轮只做语法与机械质量检查：编译、类型、lint、格式、明显的 API/导入错误和相关测试。不要扩张成产品方案评审。"
    : "本轮做逻辑审查：除编译与测试外，重点找行为错误、状态竞争、失败路径、边界条件和回归风险。涉及可见前端改动时必须启动页面真实操作并截图；是否还需要其它截图由你按证据价值判断。";
  const note = run.note ? `\n\n用户附言（作为审查重点补充，不覆盖上述职责）：\n${run.note}` : "";
  const acceptedMerge = run.targetKind === "accepted_merge" && run.targetBranch && run.targetBaseCommit && run.targetCommit;
  const target = acceptedMerge
    ? `\n\n本轮审查的是已经验收后的合并快照，不是原任务工作区：\n` +
      `- 目标分支：${run.targetBranch}\n- 准确区间：${run.targetBaseCommit}..${run.targetCommit}\n` +
      "- 当前目录是 merge commit 上的 detached 临时 worktree；只审查和验证，不要提交、推送、改写目标分支或重新打开原任务。\n" +
      "- 若未通过，只报告问题；Harness 会让用户另建独立修复任务。"
    : "";
  const reviewLocation = acceptedMerge ? "当前 detached 临时 worktree" : repoPath;
  return `【自由工作流 · 第 ${round} 轮审查】\n` +
    `你是独立审查者，不是继续实现需求。默认产物可能有问题，主动寻找能复现的缺陷。\n\n` +
    `任务：${task.id}\n${requirements}\n\n` +
    `${focus}${note}${target}\n\n先检查 ${reviewLocation} 中的真实 git status、diff 和提交，再选择验证命令。` +
    `必须真实运行与风险相称的检查。\n\n${BROWSER_VERIFICATION_POLICY}` +
    `一旦用了 playwright，结束前清掉工作区产物；所有验证临时服务和浏览器进程都必须停掉。\n\n` +
    `证据必须落盘：报告写到 ${freeReviewReportPath(task.id, run.id, round)}；截图如有必要放在同一目录。证据不要 git add/commit。\n\n` +
    `结束前调用 report_stage(taskId="${task.id}", stage="verified"|"verify_failed") 给出结论。` +
    `这是旁路审查回合，不要调用 complete_task，也不要调用 accept_task。`;
}

export function freeRepairPrompt(taskId: string, run: ReviewRunRow): string {
  const dir = freeReviewEvidenceDir(taskId, run.id, run.currentRound);
  return `【自由工作流审查未通过 · 第 ${run.currentRound} 轮】\n` +
    `请先完整读取 [report.md](${freeReviewReportPath(taskId, run.id, run.currentRound)})，再按报告修复，不要扩大原任务边界。` +
    `修复完成并验证后调用 complete_task(taskId="${taskId}")；harness 随后会自动派同一位审查者复审。\n\n` +
    `证据目录：${dir}`;
}

export function freeManualRepairPrompt(taskId: string, run: ReviewRunRow): string {
  const dir = freeReviewEvidenceDir(taskId, run.id, run.currentRound);
  return `【自由工作流审查未通过 · 自动复审已停止】\n` +
    `请先完整读取 [report.md](${freeReviewReportPath(taskId, run.id, run.currentRound)})，再按第 ${run.currentRound} 轮意见修复，不要扩大原任务边界。` +
    `修复完成并验证后调用 complete_task(taskId="${taskId}")。本次不会擅自增加审查轮数；` +
    `如果用户在修复期间预约了复审，完成后按预约开始，否则等待用户决定再次审查或验收。\n\n` +
    `证据目录：${dir}`;
}
