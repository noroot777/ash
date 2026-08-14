// 验证轮要对 agent 说的话：协议正文（进这一轮时说一次）、每回合的提醒（中途提问、
// 被打断再续跑时靠它跟到底）、以及没过时交回原任务的修复提示。
//
// 从 review.ts 拆出来的理由跟 review-evidence.ts 一样：这一层只负责措辞，编排逻辑
// 不该被几百行提示词正文淹掉。两套说法并存：
//   - `verifyProtocolFor` —— **现在的做法**：就地验证，在被验任务自己身上多跑一个
//     旁路回合，不另起任务。
//   - `reviewProtocolFor` —— 历史做法：另起一个独立审查任务。老任务身上还挂着这种
//     审查任务，它们得能继续跑完，所以这段话留着。
import { join } from "node:path";
import type { ReviewCoverageFinding } from "./review-coverage.js";
import { repairCoverageGuard } from "./review-coverage.js";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { VERIFY_CHECK_LABELS } from "@harness/shared/workflow";
import { workflowPolicy } from "@harness/shared/workflow-policy";
import { taskWorkflowDef } from "./workflows.js";
import { reviewRoundDir } from "./review-evidence.js";
import { reviewRequestReference } from "./review-request-context.js";
import { BROWSER_VERIFICATION_POLICY, BROWSER_VERIFICATION_REMINDER } from "./browser-verification-policy.js";
import type { Workspace } from "./git.js";

type TaskRow = typeof tasks.$inferSelect;

export const REVIEW_OVERWRITE_CHECK =
  "若声称行为在仓库里不存在或已被改掉，先查被审产物提交之后是否有后续提交触及同批文件；" +
  "若有，在报告写明“疑似被后续提交有意覆盖，建议人工确认而非自动打回”及提交 hash、说明和文件，" +
  "并先调用 ask_question 等人工确认，不要仅因此上报 verify_failed。";

// 「验什么」是用户在线上勾的，不能只画在界面里：不传给验证者，那几个勾就是装饰。
// 一条线上可以有好几站验证，各勾各的——所以读**这一轮验的那一站**。
function requiredChecks(target: TaskRow, at: string | null | undefined): string {
  const checks = workflowPolicy(taskWorkflowDef(target.workflow), at)?.verify?.p.checks ?? [];
  return checks.length
    ? `这条线上勾的验证项必须逐项过：${checks.map((c) => VERIFY_CHECK_LABELS[c]).join("、")}。` +
      `发现别的风险照样报，但这几项不能跳。\n\n`
    : "";
}

// 「怎么验、证据放哪」两套说法共用的正文。
//
// 截图是**按需**的（用户 2026-08-06 拍板）：一张没人看的截图不叫证据，只是给验收的人
// 多一次点开再关掉。判据写成「改动看不看得见」而不是「web / 非 web」——同样是 web 改动，
// 调个接口超时跟挪个按钮，前者截图上什么都看不出来。真实运行验证本身一步都不减。
function verifyRules(evidenceDir: string): string {
  return `必须真实运行验证：只读代码或只过编译不算。web 改动必须启动服务、用浏览器确认行为；` +
    `其它改动也必须运行与风险相称的测试或产物。\n\n` +
    BROWSER_VERIFICATION_POLICY +
    `一旦用了 playwright，验证结束前必须把它落在仓库工作区里的产物删干净（.playwright-cli/、playwright-report/、test-results/ 等），` +
    `并用 git status 确认没有留下未跟踪文件——残留会把工作区弄脏，直接导致后续验收合并被拒。\n\n` +
    `验证收尾必须清场：结束前把你为验证启动的所有服务/进程全部停掉（dev server、mock server、throwaway 实例等），` +
    `确认监听端口已释放，不许留孤儿进程在后台。\n\n` +
    `证据强制落盘：\n` +
    `- 必写报告：${join(evidenceDir, "report.md")}（包含结论、依据、发现的问题）——**报告是唯一必交的证据**，` +
    `跑过的命令与关键输出贴进去\n` +
    `- 截图按需：**改动看得见**（界面、渲染结果、视觉回归）时必须截，因为文字替代不了；` +
    `看不见的改动（服务端逻辑、CLI、脚本、纯数据）**不需要截图就别截**，别为了凑证据补一张没有信息量的图。截了就放在 ${evidenceDir} 目录内\n` +
    `- 证据**只落盘，绝不 git add / commit 进仓库**（data/ 本就在 .gitignore 里，不要 -f 强加）：` +
    `验收界面直接从磁盘读证据，塞进 git 只会拿二进制文件污染被审分支的验收 diff\n\n`;
}

/**
 * 就地验证轮的协议正文。跟独立审查任务那份的差别只有两处，但都是要害：
 * ① 你**已经在**被验的工作目录里，不用再找它在哪；
 * ② 结论调 `report_stage` 报给**你自己**，本回合**不要**调 `complete_task` ——
 *    这一轮是搭着任务跑的旁路回合，任务的完成状态不由它改写。
 *
 * 原始正文和中途追加需求由 `reviewRequestReference` 固化到证据目录：既不能漏掉后续改动，
 * 也不能把原需求里的 skill / 斜杠命令原样塞进新审查 user message，误触本轮技能。
 */
export async function verifyProtocolFor(
  target: TaskRow,
  round: number,
  repoPath: string,
  // 这一轮验的是线上哪一站（`WorkflowStep.id`）；null = 身上没线，或回落到第一站。
  station: string | null = null,
): Promise<string> {
  const evidenceDir = reviewRoundDir(target.id, round);
  const baseline = target.useWorktree ? target.worktreeBase || "项目当前基线" : "当前工作树的基准提交";
  const requirements = await reviewRequestReference(target, evidenceDir);
  return `【自动验证 · 第 ${round} 轮】\n` +
    `这一轮不是继续做需求，而是**回过头验收你自己刚才的产物**。请切换成审查者的立场：` +
    `默认它有问题，去找出问题，而不是复述你做了什么。\n\n` +
    `验证对象：${target.id}\n${requirements}\n\n` +
    requiredChecks(target, station ?? target.workflowAt) +
    `先检查真实改动：项目仓库 ${repoPath}；你当前的工作目录就是被验产物所在的目录；` +
    `比较基线 ${baseline}。先看 git status / git diff / 相关提交，再决定验证范围。\n\n` +
    `${REVIEW_OVERWRITE_CHECK}\n\n` +
    verifyRules(evidenceDir) +
    `验证结束时，调用 report_stage(taskId="${target.id}", stage="verified"|"verify_failed") 给出本轮结论；` +
    `**本回合不要调用 complete_task** —— 这是搭在任务上的验证回合，任务本身的状态保持不变。\n\n`;
}

/** 就地验证轮的每回合提醒（中途提问、被打断续跑时，只有它跟得到底）。 */
export function verifyReminderFor(taskId: string, round: number): string {
  const dir = reviewRoundDir(taskId, round);
  return `验证提醒:你正在跑本任务的第 ${round} 轮自动验证（不是继续做需求）。必须真实运行验证并把报告写到 ${join(dir, "report.md")}，` +
    `改动看得见（界面/渲染结果）才截图、放同目录，看不见的改动不用截（都只落盘，绝不 commit 进仓库）；` +
    BROWSER_VERIFICATION_REMINDER +
    `用了 playwright 的话结束前必须删掉它在工作区的产物（.playwright-cli/ 等）；` +
    `验证完停掉自己启动的所有服务/进程；` +
    `结束前调 report_stage(taskId="${taskId}", stage="verified"|"verify_failed") 给出结论，本回合不要调 complete_task。`;
}

/** 历史做法：独立审查任务的协议正文。老任务身上还挂着这种任务，得能跑完。 */
export async function reviewProtocolFor(
  review: TaskRow,
  workspace: Workspace,
  repoPath: string,
): Promise<string> {
  if (!review.reviewOf || !review.reviewRound) return "";
  const target = (await db.select().from(tasks).where(eq(tasks.id, review.reviewOf))).at(0);
  if (!target) return `【审查任务】被审任务 ${review.reviewOf} 已不存在，记录问题后结束本轮。\n\n`;
  const evidenceDir = reviewRoundDir(target.id, review.reviewRound);
  const baseline = target.useWorktree ? target.worktreeBase || "项目当前基线" : "当前工作树的基准提交";
  const requirements = await reviewRequestReference(target, evidenceDir);
  return `【审查任务 · 第 ${review.reviewRound} 轮】\n` +
    `审查对象：${target.id}\n${requirements}\n\n` +
    requiredChecks(target, review.reviewStep ?? target.workflowAt) +
    `先检查真实改动：项目仓库 ${repoPath}；被审工作目录 ${workspace.path}；` +
    `被审分支 ${workspace.branch ?? "(无 Git 分支)"}；比较基线 ${baseline}。` +
    `先看 git status / git diff / 相关提交，再决定验证范围。\n\n` +
    `${REVIEW_OVERWRITE_CHECK}\n\n` +
    verifyRules(evidenceDir) +
    `审查结束时，调用 report_stage(taskId="${target.id}", stage="verified"|"verify_failed") 给被审任务下结论；` +
    `最后调用 complete_task(taskId="${review.id}") 确认你自己的审查任务完成。` +
    `不要给审查任务自身上报 stage。\n\n`;
}

/** 历史做法：独立审查任务的每回合提醒。 */
export function reviewReminderFor(review: Pick<TaskRow, "id" | "reviewOf" | "reviewRound">): string {
  if (!review.reviewOf || !review.reviewRound) return "";
  const dir = reviewRoundDir(review.reviewOf, review.reviewRound);
  return `审查提醒:这是第 ${review.reviewRound} 轮审查；必须真实运行验证并把报告写到 ${join(dir, "report.md")}，` +
    `改动看得见（界面/渲染结果）才截图、放同目录，看不见的改动不用截（都只落盘，绝不 commit 进仓库）；` +
    BROWSER_VERIFICATION_REMINDER +
    `用了 playwright 的话结束前必须删掉它在工作区的产物（.playwright-cli/ 等）；` +
    `验证完停掉自己启动的所有服务/进程；` +
    `结束前对被审任务 ${review.reviewOf} 调 report_stage(verified|verify_failed)，` +
    `再对审查任务自身 ${review.id} 调 complete_task。`;
}

/** 没过时交回原任务的修复提示。`reviewTaskId` 非空 = 历史那种独立审查任务给的结论。 */
export function repairPrompt(input: {
  target: TaskRow;
  round: number;
  reviewTaskId: string | null;
  coverage: ReviewCoverageFinding | null;
  autoNext: boolean;
}): string {
  const { target, round, reviewTaskId } = input;
  const dir = reviewRoundDir(target.id, round);
  const coverageGuard = repairCoverageGuard(input.coverage);
  return `【自动验证未通过 · 第 ${round} 轮】\n` +
    (reviewTaskId
      ? `审查任务 ${reviewTaskId} 已给出 verify_failed。`
      : `第 ${round} 轮验证结论是 verify_failed。`) +
    `请先完整读取 [report.md](${join(dir, "report.md")})，再按报告修复，不要扩大原任务边界。\n\n` +
    (coverageGuard ? `${coverageGuard}\n\n` : "") +
    `证据目录：${dir}\n\n` +
    `修完必须调用 complete_task(taskId="${target.id}") 确认完成；` +
    (input.autoNext ? "确认后 harness 会自动再验一轮。" : "本轮不自动续验，确认后可由用户手动再验一轮。");
}
