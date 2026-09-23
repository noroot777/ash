// 自由工作流的三段 prompt 文案（从 free-workflow.ts 拆出，纯行数拆分）：
// 派审回合、自动修复交接、轮数用尽后的手动修复交接；外加「驳回 / 辩论」那条支线的
// 措辞（修复交接里的驳回选项、辩论每一段的开场白）。
import { freeReviewDebateTurns, freeReviewDebates, freeReviewRuns, tasks } from "./db/schema.js";
import { freeReviewEvidenceDir, freeReviewReportPath } from "./free-review-files.js";
import { reviewRequestReference } from "./review-request-context.js";
import { BROWSER_VERIFICATION_POLICY } from "./browser-verification-policy.js";

type TaskRow = typeof tasks.$inferSelect;
type ReviewRunRow = typeof freeReviewRuns.$inferSelect;
type DebateRow = typeof freeReviewDebates.$inferSelect;
type DebateTurnRow = typeof freeReviewDebateTurns.$inferSelect;

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
      "- 若未通过，只报告问题；Ash 会让用户另建独立修复任务。"
    : "";
  const reviewLocation = acceptedMerge ? "当前 detached 临时 worktree" : repoPath;
  return `【自由工作流 · 第 ${round} 轮审查】\n` +
    `你是独立审查者，不是继续实现需求。默认产物可能有问题，主动寻找能复现的缺陷。\n\n` +
    `任务：${task.id}\n${requirements}\n\n` +
    `${focus}${note}${target}\n\n先检查 ${reviewLocation} 中的真实 git status、diff 和提交，再选择验证命令。` +
    `必须真实运行与风险相称的检查。\n\n${BROWSER_VERIFICATION_POLICY}` +
    `一旦用了 playwright，结束前清掉工作区产物；所有验证临时服务和浏览器进程都必须停掉。\n\n` +
    `证据必须落盘：报告写到 ${freeReviewReportPath(task.id, run.id, round)}；截图如有必要放在同一目录。证据不要 git add/commit。\n\n` +
    `结束前调用 report_stage(taskId="${task.id}", stage="verified"|"verify_failed", directionToken="<最新【当前方向身份】token>") 给出结论。` +
    `这是旁路审查回合，不要调用 complete_task，也不要调用 accept_task。`;
}

/**
 * 崩掉的那一轮**从中断处接着做**时送的那句话（判据见 `transcript.ts` 的 turnProducedWork）。
 *
 * 刻意只有几行：审查者的上文里已经有整份任务书和它自己做到一半的分析，把任务书再发一遍
 * 等于让它从头再读一遍代码 —— 这一轮崩在 10M token 上，重来一次就是再烧 10M。
 * 只补两样上文尾巴最可能被截断、丢了就收不了尾的东西：报告落盘路径，和上报结论的调用。
 */
export function freeReviewResumeMessage(task: TaskRow, run: ReviewRunRow, round: number): string {
  const what = run.targetKind === "accepted_merge" ? "合并结果审查" : `第 ${round} 轮审查`;
  return `【自由工作流 · ${what} · 从中断处继续】\n` +
    `上一回合在中途异常结束（多半是 CLI 与模型之间掉线），不是你做错了什么。` +
    `你这一轮已经做过的分析都还在上文里。\n\n` +
    `请**接着往下把这一轮做完**，不要从头重看一遍已经看过的东西；` +
    `只有确实被打断、结论悬空的那几步才值得重跑。\n\n` +
    `收尾照旧：报告写到 ${freeReviewReportPath(task.id, run.id, round)}；` +
    `结束前调用 report_stage(taskId="${task.id}", stage="verified"|"verify_failed", directionToken="<最新【当前方向身份】token>") 给出结论。` +
    `这是旁路审查回合，不要调用 complete_task，也不要调用 accept_task。`;
}

/**
 * 交回执行者时必须一起说的那句话：**你可以不同意**。
 *
 * 不说这一句，交接就只有一条路——照改。于是「报告读错了代码」和「这条意见我确实该改」
 * 在行为上没有区别：前者会被改成一版更差的代码，而用户永远看不到执行者其实不认账
 * （审查实测的反例是执行者在会话里辩解两句、然后照改，状态里一个字都没留下）。
 *
 * 措辞有意偏保守：默认仍是照改，驳回是**例外**且要求逐条给依据——否则它会变成一条
 * 逃避修复的捷径。
 */
function disputeOption(taskId: string): string {
  return `\n\n如果报告里有**你认为不成立**的意见（读错了代码、依据不可复现），或者那是一处` +
    `**知情且有意为之**的设计、这次不该改：不要勉强照改，也不要只在回复里辩解两句了事——` +
    `调用 dispute_review(taskId="${taskId}", reason="逐条写清哪一条不成立、依据是什么（指到文件/行/可复现步骤）", ` +
    `directionToken="<最新【当前方向身份】token>") 把驳回落下来，然后结束本回合，由用户裁定。\n` +
    `- 部分成立时：先把成立的那几条改掉并验证，再用 dispute_review 只驳不成立的那几条，理由里写明你已经改了什么。\n` +
    `- 驳回之后**不要**调用 complete_task：这一轮停在「等用户裁定」，不是完成。\n` +
    `- 默认仍然是照报告修复；驳回是例外，拿不出具体依据就不要用。`;
}

export function freeRepairPrompt(taskId: string, run: ReviewRunRow): string {
  const dir = freeReviewEvidenceDir(taskId, run.id, run.currentRound);
  return `【自由工作流审查未通过 · 第 ${run.currentRound} 轮】\n` +
    `请先完整读取 [report.md](${freeReviewReportPath(taskId, run.id, run.currentRound)})，再按报告修复，不要扩大原任务边界。` +
    `修复完成并验证后调用 complete_task(taskId="${taskId}") 确认任务完成；已预约的复审会在修复回合正常结束后自动启动。\n\n` +
    `证据目录：${dir}` +
    disputeOption(taskId);
}

export function freeManualRepairPrompt(
  taskId: string,
  run: ReviewRunRow,
  // 用户已经裁定「维持审查意见」：这一趟没有驳回这条路了，照改。
  opts: { disputeUpheld?: boolean } = {},
): string {
  const dir = freeReviewEvidenceDir(taskId, run.id, run.currentRound);
  return `【自由工作流审查未通过 · 自动复审已停止】\n` +
    (opts.disputeUpheld
      ? `你驳回过这一轮意见，用户已经裁定**维持审查意见**。这一次请照报告修复，不要再驳回；` +
        `确有做不到的地方就用 ask_question 说清楚，别默默跳过。\n`
      : "") +
    `请先完整读取 [report.md](${freeReviewReportPath(taskId, run.id, run.currentRound)})，再按第 ${run.currentRound} 轮意见修复，不要扩大原任务边界。` +
    `修复完成并验证后调用 complete_task(taskId="${taskId}")。本次不会擅自增加审查轮数；` +
    `如果用户在修复期间预约了复审，执行回合正常结束后按预约开始，否则等待用户决定再次审查或验收。\n\n` +
    `证据目录：${dir}` +
    (opts.disputeUpheld ? "" : disputeOption(taskId));
}

/**
 * 辩论一段的开场白。两侧共用一份骨架，差别只在**称呼和这一段要回应谁**——各写一份
 * 的话，「只许说话不许改代码」这类规矩迟早只剩一侧还留着。
 *
 * 完整记录每段都重发一遍：执行者的会话里没有审查者说过的话，反过来也一样，只靠各自
 * 的上文，两边会各说各的。
 */
export function debatePrompt(input: {
  task: TaskRow;
  run: ReviewRunRow;
  debate: DebateRow;
  turn: DebateTurnRow;
  disputeReason: string;
  previous: DebateTurnRow[];
  repoPath: string;
}): string {
  const { task, run, debate, turn, disputeReason, repoPath } = input;
  const total = debate.exchanges * 2 + 1;
  const final = turn.seq >= total;
  const reviewer = turn.side === "reviewer";
  const report = freeReviewReportPath(task.id, run.id, debate.round);
  const spoken = input.previous
    .filter((row) => row.status === "done" && row.statement)
    .map((row) => `〔第 ${row.seq} 段 · ${row.side === "reviewer" ? "审查者" : "执行者"}〕\n${row.statement}`)
    .join("\n\n");
  const history = `已经说过的（按顺序）：\n\n〔执行者的驳回〕\n${disputeReason}` +
    (spoken ? `\n\n${spoken}` : "");
  const role = reviewer
    ? `你是**审查者**（${run.reviewerName}），第 ${debate.round} 轮那份未通过报告是你写的：${report}`
    : "你是**执行者**，被审的这版代码是你写的，驳回也是你提的";
  const ask = final
    ? "这是**收尾发言**：逐条给出你的最终立场——哪几条维持、哪几条撤回、哪几条只是建议；" +
      "并明确告诉用户，按你的判断他现在该怎么做。"
    : reviewer
      ? "请逐条回应驳回：哪几条你坚持、依据是什么（指到具体文件/行/可复现步骤）；哪几条你接受。" +
        "不要重复报告原文，只说有争议的那几条。"
      : "请逐条回应审查者刚才的反驳：哪几条你继续坚持、依据是什么；哪几条你接受、打算怎么改（**这一段只说打算，不要动手**）。";

  return `【审查意见辩论 · 第 ${turn.seq}/${total} 段${final ? " · 收尾" : ""}】\n` +
    `${role}。用户看过你们各执一词之后，要你们各自把话说清楚，最后**由用户裁定**。\n\n` +
    `任务：${task.id}\n项目仓库：${repoPath}\n第 ${debate.round} 轮审查报告：${report}\n\n` +
    `${history}\n\n${ask}\n\n` +
    `**这一段只辩论，不改代码**：不要编辑任何文件、不要提交、不要跑会改变状态的命令；` +
    `只读代码、只读日志、必要时只读地复核可以。一边辩一边改的话，下一段的对方看到的就是另一版代码了。\n\n` +
    `说完调用 debate_reply(taskId="${task.id}", statement="<你这一段的完整发言>"` +
    `${final ? `, verdict="upheld|withdrawn|partial"` : ""}, directionToken="<最新【当前方向身份】token>") 交卷，` +
    `然后结束本回合。**不要**调用 report_stage / complete_task / accept_task / dispute_review：` +
    `这一段既不改结论也不改任务状态${final ? "——你的 verdict 只是你的立场，裁定权在用户手上" : ""}。` +
    (final ? "" : "\n没有调用 debate_reply 就结束回合的话，这场辩论会按「没说话」中止。");
}
