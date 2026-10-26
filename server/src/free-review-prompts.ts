// 自由工作流的三段 prompt 文案（从 free-workflow.ts 拆出，纯行数拆分）：
// 派审回合、自动修复交接、轮数用尽后的手动修复交接；外加「驳回 / 辩论」那条支线的
// 措辞（修复交接里的驳回选项、辩论每一段的开场白）。
import { freeReviewDebateTurns, freeReviewDebates, freeReviewRuns, tasks } from "./db/schema.js";
import { freeReviewEvidenceDir, freeReviewReportPath } from "./free-review-files.js";
import { reviewRequestReference } from "./review-request-context.js";
import { settledRulingsFor } from "./free-review-settled.js";
import { REPORT_SUMMARY_FORMAT, REPORT_SUMMARY_REMINDER } from "./review-report-format.js";
import {
  REVIEW_VALIDATION_REQUIREMENT,
  REVIEWER_REGRESSION_CLAUSE,
} from "@ash/shared/free-workflow";
import { CLASS_REPAIR_NOTE, REVIEW_SWEEP_PROTOCOL, REVIEW_SWEEP_REMINDER } from "./review-sweep.js";
import { freeReviewHistorySection } from "./review-history.js";
import { refreshRegressionEvidence } from "./regression-evidence-lifecycle.js";

type TaskRow = typeof tasks.$inferSelect;
type ReviewRunRow = typeof freeReviewRuns.$inferSelect;
type DebateRow = typeof freeReviewDebates.$inferSelect;
type DebateTurnRow = typeof freeReviewDebateTurns.$inferSelect;

export async function freeReviewPrompt(task: TaskRow, run: ReviewRunRow, round: number, repoPath: string): Promise<string> {
  const dir = freeReviewEvidenceDir(task.id, run.id, round);
  const requirements = await reviewRequestReference(task, dir);
  // 开场这两句**不能提「跑测试」**：同一条消息后半段（`REVIEW_VALIDATION_REQUIREMENT`）明说
  // 审查者一条回归都不跑，第 1 轮审查实测这两句话确实同时出现在真实任务书里。语法审查改成
  // 「读测试代码」，逻辑审查改成「除构建与必要冒烟外」—— 禁的是回归，不是一切执行。
  const focus = run.checkMode === "syntax"
    ? "本轮只做语法与机械质量检查：编译、类型、lint、格式、明显的 API/导入错误，以及测试代码本身的机械问题（读它，不跑回归）；不要扩张成产品方案评审。"
    : "本轮做逻辑审查：除构建与必要冒烟外，重点找行为错误、状态竞争、失败路径、边界条件和回归风险。涉及可见前端改动时必须启动页面真实操作并截图，其余截图按证据价值自己判断。";
  const note = run.note ? `\n\n用户附言（作为审查重点补充，不覆盖上述职责）：\n${run.note}` : "";
  // 上一条审查链里已被用户裁定「不在本任务里修」的那几条：不带过来的话，新审查者会
  // 把同样几条原样再报一遍，用户只能每轮手打一句「有异议的已经转为新任务」（理由见
  // free-review-settled.ts 文件头）。放在用户附言**之前**：它是边界事实，附言是这一
  // 次的重点补充，附言里说的话仍然压在最后一句。
  const settled = await settledRulingsFor({
    taskId: task.id, current: { runId: run.id, round }, audience: "reviewer", evidenceDir: dir,
  });
  // 前面各轮（含别的审查链）报过的现象行：跨 run 的会话是断的，不搬过去它就只能把自己
  // 复现到的那一条当独立缺陷报上来（理由见 review-history.ts 文件头）。
  const history = await freeReviewHistorySection(task.id, { runId: run.id, round });
  const acceptedMerge = run.targetKind === "accepted_merge" && run.targetBranch && run.targetBaseCommit && run.targetCommit;
  const target = acceptedMerge
    ? `\n\n本轮审查的是已经验收后的合并快照，不是原任务工作区：\n` +
      `- 目标分支：${run.targetBranch}\n- 准确区间：${run.targetBaseCommit}..${run.targetCommit}\n` +
      "- 当前目录是 merge commit 上的 detached 临时 worktree；只审查和验证，不要提交、推送、改写目标分支或重新打开原任务。\n" +
      "- 若未通过，只报告问题；Ash 会让用户另建独立修复任务。"
    : "";
  const reviewLocation = acceptedMerge ? "当前 detached 临时 worktree" : repoPath;
  // 扫描义务**不再分 workspace / accepted_merge 两份**：原先那个分叉存在的唯一理由是
  // 「任务分支的回归结果能不能复用」，而回归复用这件事已经整体退役（回归统一在验收时跑，
  // 审查者一条都不跑，口径见 `@ash/shared/free-workflow` 的 `REGRESSION_POLICY`）。
  // 两种目标现在只差一句话，由 `refreshRegressionEvidence` 的清单说明自己交代。
  // 口径本体由同一条消息末段的 `REVIEW_VALIDATION_REQUIREMENT` 讲一遍就够,清单说明只讲
  // 「这份文件怎么读」—— 原先这条消息里同一段口径出现三遍(扫描义务回归面、清单说明、验证义务)。
  const { reference: regression } = await refreshRegressionEvidence(
    task.id, dir, run.targetKind === "accepted_merge", false);
  return `【自由工作流 · 第 ${round} 轮审查】\n` +
    // 这里原先写「主动寻找能复现的缺陷」，跟下面扫描义务里的「做不到可复现也不许删掉这一条」
    // 直接打架 —— 同一段 prompt 里两句话冲突，它只能自己挑一个，挑错了没人看得出来。
    // 所以把「能复现」收窄到最重的那几条，其余条目的去处由扫描义务那一节交代。
    `你是独立审查者，不是继续实现需求。默认产物有问题，主动把问题找全；最严重的那几条要做到能复现。\n\n` +
    `任务：${task.id}\n${requirements}\n\n` +
    `${focus}${settled}${history}${note}${target}\n\n` +
    // 扫描义务摆在具体动作之前：先定「这一轮要扫到什么程度」，再说「先看 git status」。
    REVIEW_SWEEP_PROTOCOL + regression + "\n\n" +
    `先检查 ${reviewLocation} 中的真实 git status、diff 和提交，再选择验证命令。` +
    // 浏览器策略**不在这里拼**:正文是提前生成的,这里拼死的只能是一份「默认未授权」的
    // 文本,而投递时读到的项目授权会被去重锚点挡在门外 —— 已经在项目设置里授权过的站点,
    // 审查回合照样停下来等人点头,无人值守就断在这儿(第 6 链第 1 轮审查 P2)。
    // 统一由投递点 withGlobalBrowserPolicy 贴那一份**带最新授权**的。
    REVIEW_VALIDATION_REQUIREMENT + "\n\n" +
    `用过 playwright 就在结束前清掉工作区产物；所有验证临时服务与浏览器进程都要停掉。\n\n` +
    `证据必须落盘：报告写到 ${freeReviewReportPath(task.id, run.id, round)}，截图按需放同一目录；证据不要 git add/commit。\n\n` +
    REPORT_SUMMARY_FORMAT +
    `结束前调用 report_stage(taskId="${task.id}", stage="verified"|"verify_failed", directionToken="<最新【当前方向身份】token>") 给出结论。` +
    `旁路审查回合：不要调用 complete_task / accept_task。`;
}

/**
 * 崩掉的那一轮**从中断处接着做**时送的那句话（判据见 `transcript.ts` 的 turnProducedWork）。
 *
 * 刻意只有几行：审查者的上文里已经有整份任务书和它自己做到一半的分析，把任务书再发一遍
 * 等于让它从头再读一遍代码 —— 这一轮崩在 10M token 上，重来一次就是再烧 10M。
 * 只补三样上文尾巴最可能被截断、丢了就收不了尾的东西：报告落盘路径、报告开头那一节的
 * 格式、以及上报结论的调用。
 */
export function freeReviewResumeMessage(task: TaskRow, run: ReviewRunRow, round: number): string {
  const what = run.targetKind === "accepted_merge" ? "合并结果审查" : `第 ${round} 轮审查`;
  return `【自由工作流 · ${what} · 从中断处继续】\n` +
    `请接着完成本轮，**不要从头**重看；只补跑被打断、结论悬空的步骤。\n\n` +
    `报告写到 ${freeReviewReportPath(task.id, run.id, round)}；` +
    REPORT_SUMMARY_REMINDER +
    // 续跑只带「收尾时仍然做得到」的那几条扫描义务（`short` 非 null 的）：这一轮的广度
    // 扫描已经过去了，再要求它重扫等于把续跑省下的 10M token 又烧一遍。
    REVIEW_SWEEP_REMINDER +
    // 回归口径在续跑路径上**两种目标都得说一句**：扫描义务的缩略版不带回归面（它 short 为
    // null，收尾回合重扫没有意义），原先这句话是由退役了的「复用协议」顺带捎上的，删掉它
    // 之后合并结果审查那一支一个字都不剩 —— 而「没人跟它说」和「跟它说了不要跑」在
    // 行为上差一轮测试（`test-regression-reuse.ts` 钉住两支都有）。
    REVIEWER_REGRESSION_CLAUSE +
    (run.targetKind === "accepted_merge"
      ? "（这一轮没有执行者登记清单可核对，回归面整面留白。）"
      : "（本轮清单在同目录 regression-evidence.json。）") +
    `结束前调用 report_stage(taskId="${task.id}", stage="verified"|"verify_failed", directionToken="<最新【当前方向身份】token>") 给出结论。` +
    `旁路回合：不要调用 complete_task / accept_task。`;
}

/**
 * 交回执行者时必须一起说的那句话：**你可以不同意**。
 *
 * 不说这一句，交接就只有一条路——照改。于是「报告读错了代码」和「这条意见我确实该改」
 * 在行为上没有区别：前者会被改成一版更差的代码，而用户永远看不到执行者其实不认账
 * （审查实测的反例是执行者在会话里辩解两句、然后照改，状态里一个字都没留下）。
 *
 * **这里只放指针，判据全文住在 `dispute_review` 工具的 description 与字段说明里。**
 * 两边都写全文时，同一段判据在一条修复消息里出现两三份，而驳回的实际发生率只有约 6%
 * （9-23 以来 1162 轮里 68 次）—— 那是在为一个低频分支按每轮付费。工具说明本来就随
 * 工具清单常驻每个回合的上下文，执行者真要调它的那一刻一定读得到；交接消息只负责
 * 「告诉它这条路存在、默认仍是照改」。
 *
 * 判据本体的单源分布（体积闸 `test-prompt-budget.ts` 钉着「各自只出现一处」）：
 * - `DEFER_BOUNDARY_CRITERION` / `DEFER_REASON_FIELD_GUIDE` → `dispute_review` 工具；
 * - `CLASS_PROBLEM_BOUNDARY` → 修复交接里的 `CLASS_REPAIR_NOTE`（预设/旧验证那条线共用）；
 * - `PLAIN_SUMMARY_GUIDE` → 两个工具的 `summary` 字段说明与入参报错。
 */
function disputeOption(taskId: string): string {
  return `\n\n**你不必 100% 认可那份报告**：读错了代码、依据不可复现、那处知情且有意为之，` +
    `或者它成立但与本任务要做的那件事无关——这几种别勉强照改，也别只在回复里辩两句，` +
    `调 dispute_review(taskId="${taskId}", summary=…, reason=…, deferReason=…, ` +
    `directionToken="<最新【当前方向身份】token>") 落下来再结束本回合等裁定` +
    `（判据与各字段写法见该工具说明）。\n` +
    `默认仍是照改，拿不出具体依据就别用；部分成立先改掉成立的那几条再只驳剩下的；` +
    `驳回后**不要**调 complete_task（这一轮停在等裁定，不是完成）。`;
}

export async function freeRepairPrompt(taskId: string, run: ReviewRunRow): Promise<string> {
  const dir = freeReviewEvidenceDir(taskId, run.id, run.currentRound);
  return `【自由工作流审查未通过 · 第 ${run.currentRound} 轮】\n` +
    `请先完整读取 [report.md](${freeReviewReportPath(taskId, run.id, run.currentRound)})，再按报告修复，不要扩大原任务边界。` +
    CLASS_REPAIR_NOTE +
    `修复并验证后调 complete_task(taskId="${taskId}")；已预约的复审会在本回合正常结束后自动启动。\n\n` +
    `证据目录：${dir}` +
    // 已经裁定转出/作废的那几条也要告诉执行者：报告是新审查者写的，它可能不知道那场
    // 裁定，而照着改就是两处各改一版（理由见 free-review-settled.ts 文件头）。
    await settledRulingsFor({
      taskId, current: { runId: run.id, round: run.currentRound }, audience: "executor", evidenceDir: dir,
    }) +
    disputeOption(taskId);
}

/**
 * 审查者的辩论收尾发言，读法见 free-review-debate.ts 的 `debateClosingOf`。
 * `verdictLabel` 已经是中文标签（"部分成立"…）——在这里再 import 一次那张表会把
 * prompts ← debate 这条依赖变成环。
 */
export interface DebateClosing {
  seq: number;
  total: number;
  verdictLabel: string | null;
  statement: string;
}

/**
 * 审查者的辩论收尾发言，**整段内联**。
 *
 * 为什么不能只给路径、也不能指望执行者会话里有：段序是奇数=审查者、偶数=执行者，
 * 总段数 2n+1，所以收尾必定由审查者说；而它说完辩论直接 finished，不再给执行者发段
 * （free-review-debate.ts `settleDebateTurn`）。也就是说**执行者的上下文里结构上不可能
 * 有这一段**。不带上的话，辩论辩出来的共识对真正去改代码的那一方就是不存在的：用户
 * 点「让它接着改」，执行者只会照原报告改——哪怕审查者自己在收尾里已经改了主意。
 *
 * 同时必须写死它**不是结论**：裁定权只在用户手上（见 free-review-dispute.ts 文件头
 * 规矩③）。把被驳回一方的收尾发言当指令执行，等于绕开裁定这件事本身。
 */
function debateClosingSection(closing: DebateClosing | null | undefined): string {
  if (!closing?.statement.trim()) return "";
  return `\n\n【审查者的辩论收尾发言 · 第 ${closing.seq}/${closing.total} 段】` +
    `\n这一段是在你最后一次发言**之后**说的，**你的会话里没有它**，所以整段抄在这里。` +
    (closing.verdictLabel ? `\n它的自述立场：${closing.verdictLabel}` : "") +
    `\n\n${closing.statement.trim()}\n\n` +
    "以上是审查者自己的立场，**不是结论**——要不要改、怎么改，以报告和下面用户的裁定为准。";
}

/**
 * 用户裁定时写给执行者的要点。
 *
 * 它**压过报告**，这句必须写在提示里：报告是审查者的一份判断，用户才是裁定人。
 * 不说清优先级的话，执行者拿到两份互相打架的要求，只能自己挑一个——而挑错的那次
 * 没有任何人会发现，因为两边看着都「按要求改了」。
 */
function resolutionNoteSection(note: string | null | undefined): string {
  const text = note?.trim();
  if (!text) return "";
  return `\n\n【用户裁定时写给你的要点】\n\n${text}\n\n` +
    "这段话出自**裁定人**：与报告冲突的地方一律以它为准，它没提到的部分仍按报告修。" +
    "读不懂或做不到就用 ask_question 问清楚，别自己挑一个改法。";
}

export async function freeManualRepairPrompt(
  taskId: string,
  run: ReviewRunRow,
  // 用户已经裁定「维持审查意见」（界面上那颗按钮写的是「让它接着改」）：这一趟没有
  // 驳回这条路了，照改。`resolutionNote` / `debateClosing` 是那场裁定与辩论真正留给
  // 执行者的东西，理由见上面两个 section —— 少任何一边，「双方辩完达成的共识」都到
  // 不了改代码的那一方。
  opts: {
    disputeUpheld?: boolean;
    resolutionNote?: string | null;
    debateClosing?: DebateClosing | null;
  } = {},
): Promise<string> {
  const dir = freeReviewEvidenceDir(taskId, run.id, run.currentRound);
  // 有要点时开场白不能再写「照报告修复」：用户写要点，多半正是因为要改的不是报告那版。
  // 两句话打架时执行者只能自己挑一个，而挑错了没人会发现（两边看着都「按要求改了」）。
  const noted = !!opts.resolutionNote?.trim();
  return `【自由工作流审查未通过 · 自动复审已停止】\n` +
    (opts.disputeUpheld
      ? `你驳回过这一轮意见，用户已经裁定**不采纳这条驳回**，让你接着改。` +
        (noted ? `按下面【用户裁定时写给你的要点】和报告来改` : `这一次请照报告修复`) +
        `，不要再驳回；确有做不到的地方就用 ask_question 说清楚，别默默跳过。\n`
      : "") +
    `请先完整读取 [report.md](${freeReviewReportPath(taskId, run.id, run.currentRound)})，再按第 ${run.currentRound} 轮意见修复，不要扩大原任务边界。` +
    CLASS_REPAIR_NOTE +
    `修复并验证后调 complete_task(taskId="${taskId}")。本次不会擅自增加审查轮数；` +
    `用户若在修复期间预约了复审，本回合正常结束后按预约开始，否则等用户决定再审或验收。\n\n` +
    `证据目录：${dir}` +
    await settledRulingsFor({
      taskId, current: { runId: run.id, round: run.currentRound }, audience: "executor", evidenceDir: dir,
      disputeUpheld: opts.disputeUpheld === true,
    }) +
    debateClosingSection(opts.debateClosing) +
    resolutionNoteSection(opts.resolutionNote) +
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
    `说完调用 debate_reply(taskId="${task.id}", summary="<一句人话，见下>", statement="<你这一段的完整发言>"` +
    `${final ? `, verdict="upheld|withdrawn|partial"` : ""}, directionToken="<最新【当前方向身份】token>") 交卷，` +
    // 一场辩论七段、合起来上万字，而用户开辩论的目的就是裁定。逐段这一句是他唯一会
    // 逐段读的东西，正文在界面上默认折着。
    `\n**summary 必填**：用户会逐段只读这一句来判断这场辩论辩到哪了（写法见该字段说明）。\n` +
    `然后结束本回合。**不要**调用 report_stage / complete_task / accept_task / dispute_review：` +
    `这一段既不改结论也不改任务状态${final ? "——你的 verdict 只是你的立场，裁定权在用户手上" : ""}。` +
    (final ? "" : "\n没有调用 debate_reply 就结束回合的话，这场辩论会按「没说话」中止。");
}
