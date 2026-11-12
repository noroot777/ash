// 「按意见修复」这一条链:**代发一条带报告链接的修复消息,不翻转任何状态。**
//
// 从 free-workflow.ts 拆出来(本轮审查 F4:那个文件被这一段顶过了单文件 700 行的硬上限)。
// 按职责切:这里是**一次用户动作**的入口 + 它的放行证明 + 投递回调;留在 free-workflow.ts
// 的是审查链自己的状态机(预约、结算、换轮、收尾)。两边唯一的接口就是下面这几个 import。
//
// 这一段自己的不变量都在各函数的注释里,拆文件没有改动其中任何一条。
import { reviewAnchorMatches } from "@ash/shared/free-workflow";
import { and, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns, tasks } from "./db/schema.js";
import { activeDebateOf, debateClosingOf } from "./free-review-debate.js";
import {
  currentRoundOf, upholdDisputeOn, type DisputeTarget, type ReviewRoundRow,
} from "./free-review-dispute.js";
import { readFreeReviewReport } from "./free-review-files.js";
import { freeManualRepairPrompt } from "./free-review-prompts.js";
import { latestWorkspaceRun, reviewingRun, type ReviewRunRow } from "./free-review-round.js";
import { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } from "./free-workflow-lock.js";
import { freeWorkflowState, workspaceStateOf, type FreeWorkflowApiState } from "./free-workflow-state.js";
import { claimOwnTurn, releaseTurn, whenTurnIdle } from "./runs.js";
import { appendTaskTimeline, alertLine, noticeLine } from "./task-timeline.js";

// 「按意见修复」按钮 = 代发一条带报告链接的修复消息，**不翻转任何状态**。
// 「修复进行中」的显示靠任务本身 running 推导；修完要不要复审看预约槽。
// 在途标记只防「双击发两条」：消息真正投出（continueTask 开跑）就清掉，之后的重复
// 点击由 running 校验拦。内存即可——重启后排队回调本来就一起丢。
const pendingRepairs = new Set<string>();

/**
 * 一次修复钉死的对象：哪条审查链的第几轮。`ruled` = 它是用户刚在裁定里点名的那一轮
 * （「让它接着改」）；否则是入口那一刻「最近一条链停下的那一轮」（老的「按意见修复」）。
 *
 * 入口定下之后，投递回调重验、修复提示、报告路径、裁定要点全都只认它，**不许再按任务
 * 去挑一遍**：未裁定驳回是任务级的，可以同时挂着好几条，「再挑一遍」挑到的未必是用户点的
 * 那张卡（第 2 轮审查实测：对旧第 1 轮裁定接着改，修复却按更新的第 2 轮报告发出）。
 */
type RepairTarget = DisputeTarget & { ruled: boolean };
type RepairSubject = { run: ReviewRunRow; round: ReviewRoundRow };
const STALE_SUBJECT = "审查意见针对的代码已变化（新提交或未提交改动）";

async function pinnedSubject(taskId: string, target: RepairTarget): Promise<RepairSubject | string> {
  const run = (await db.select().from(freeReviewRuns).where(and(
    eq(freeReviewRuns.id, target.runId), eq(freeReviewRuns.taskId, taskId), eq(freeReviewRuns.targetKind, "workspace"),
  ))).at(0);
  const round = run && (await db.select().from(freeReviewRounds)
    .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, target.round)))).at(0);
  if (!run || !round) return `第 ${target.round} 轮审查记录已经不在了`;
  if (target.ruled) {
    // 用户裁定的是**这一轮**：它必须仍是「维持意见」。别处把它改了（重跑取代、再裁一次）
    // 就停下，不换一份报告顶上。
    return round.disputeResolution === "upheld" || round.disputeResolution === "withdrawn" ||
      round.disputeResolution === "deferred" ? { run, round } : `第 ${target.round} 轮意见已经不是「让它接着改」的裁定了`;
  }
  // 老按钮修的是「最近一条链的结论」：投递时那已经不是最近的结论，就该如实取消。
  const latest = await latestWorkspaceRun(taskId);
  if (!latest || latest.status !== "stopped") return "最近一轮审查没有停在未通过状态";
  if (latest.id !== run.id || latest.currentRound !== target.round) return "这轮之后又有了新的审查结论";
  return { run, round };
}

/**
 * 「这份未通过报告仍对应当前代码」的完整证明，返回错误文案或要修的那一轮。
 * 入口校验与**投递回调**各跑一遍：入口占着 turn 校验（下面），但修复消息可能排在别的
 * 回合之后才真正投递——那个回合可以改代码，排队前的证明到投递时已经过期，不重验就会
 * 让实现 agent 按旧版报告改新版代码（审查实测：占住 turn 的普通回合结束后旧意见照发）。
 * `target` 为空只在老按钮的入口那一次：从最近一条链定下对象，之后一律带着它来。
 */
async function manualRepairSubject(taskId: string, target: RepairTarget | null): Promise<RepairSubject | string> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return "任务不存在";
  if (task.stage === "accepted" || task.stage === "merged") return "任务已进入验收结果";
  if (await reviewingRun(taskId)) return "审查回合正在进行";
  if (await activeDebateOf(taskId)) return "审查意见辩论正在进行，等它说完再决定";
  let subject: RepairSubject | string;
  if (target) subject = await pinnedSubject(taskId, target);
  else {
    const run = await latestWorkspaceRun(taskId);
    const round = run?.status === "stopped" ? await currentRoundOf(run) : null;
    subject = run && round ? { run, round } : "最近一轮审查没有停在未通过状态";
  }
  if (typeof subject === "string") return subject;
  const { run, round } = subject;
  // 用户已经裁定「不在本任务里修」的那一轮不能再拿去修：确认框写的是「执行者不再按它
  // 修改」，修复入口却照单放行的话，用户点一下就把自己刚下的裁定推翻了（第 1 轮审查实测）。
  // 转成了独立任务的那档更硬——那几条已经有别的任务在承接，这里再修一遍就是两处各改一版。
  if (round.disputeResolution === "deferred") {
    return `这一轮意见已被你裁定转为独立任务（${round.disputeDeferredTaskId ?? "待办任务"}），不在本任务里修；要继续推进请再派一轮审查`;
  }
  if (round.disputeResolution === "withdrawn") {
    return "这一轮意见已被你裁定作废（采纳了执行者的说法），不再按它修复；要继续推进请再派一轮审查";
  }
  // 报告读取走安全解析（拒 symlink 祖先），且必须有非空正文——raw existsSync 会被
  // 换成 symlink 的 round 目录骗过，把外部路径写进发给实现 agent 的提示。
  if (!readFreeReviewReport(taskId, run.id, round.round).trim()) {
    return target?.ruled ? `第 ${round.round} 轮审查报告不存在或为空` : "最近一轮审查报告不存在或为空";
  }
  // 只有能**证明**意见仍对应当前代码才放行修复（失败向「不确定」开，不向「没问题」开）：
  // 锚点缺失（老数据）、工作区读不到（已清理/非 git）都无从证明——正确动作是再派一轮
  // 「审查新改动」，而不是按一份无法核对的报告唤醒实现 agent 改代码。
  // 锚点认两个（审查那一版 / 执行者驳回那一版），判据与前端新鲜度共用 `reviewAnchorMatches`。
  if (!round.reviewedCommit && !round.reviewedFingerprint) return "这轮审查缺少基准 commit，无法确认意见仍对应当前代码";
  const anchored = reviewAnchorMatches(round, await workspaceStateOf(task, { verify: true }));
  if (anchored == null) return "工作区内容读不到（或审查时就没能记下内容），无法确认审查意见仍对应当前代码";
  if (!anchored) return STALE_SUBJECT;
  return subject;
}

async function deliverManualRepair(taskId: string, target: RepairTarget): Promise<void> {
  const abort = async (message: string) => {
    pendingRepairs.delete(taskId);
    await appendTaskTimeline(taskId, alertLine(`自由工作流审查意见修复已取消：${message}；请再派一轮审查。`));
    bus.publish({ type: "task.review", taskId });
  };
  try {
    const subject = await manualRepairSubject(taskId, target);
    if (typeof subject === "string") return void await abort(subject);
    const { run, round } = subject;
    const { continueTask } = await import("./orchestrator.js");
    // 用户裁定「维持审查意见」之后的这一趟不再给驳回这条路（措辞见 free-review-prompts）。
    // 辩论的收尾发言与用户写的裁定要点也在这里一并带上：前者执行者的会话里结构上没有，
    // 后者是三档裁定表达不了的那部分结论。少任何一边，「辩完达成的共识」都到不了真正
    // 去改代码的那一方，用户点完「让它接着改」只会看到执行者照原报告改。
    // 三样都取**钉死的那一轮**，不取链的当前轮（历史轮被裁定时两者不是一轮）。
    const delivered = await continueTask(
      taskId,
      await freeManualRepairPrompt(taskId, run, {
        round: round.round,
        disputeUpheld: round.disputeResolution === "upheld",
        resolutionNote: round.disputeResolutionNote ?? null,
        debateClosing: await debateClosingOf(round.id),
      }),
      { byBackend: true, recurrenceRound: { runId: run.id, round: round.round } },
    );
    if (delivered === false) await abort("回合被其它执行抢占，消息未能投递");
  } catch (error) {
    await abort(error instanceof Error ? error.message : String(error));
  }
}

export async function startManualFreeReviewRepair(
  taskId: string,
  // `target`：用户在裁定里点名的那一轮（「让它接着改」）。不带 = 老按钮，修最近一条链的结论。
  opts: { holdTurn?: boolean; target?: DisputeTarget | null } = {},
): Promise<FreeWorkflowApiState> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new Error("任务不存在");
  if (task.mode !== "single" || task.parentId || task.reviewOf || task.workflowMode !== "free") {
    throw new Error("当前任务不支持自由审查修复");
  }
  if (task.archived) throw new Error("归档任务不能发起修复");
  if (task.status === "backlog") throw new Error("任务尚未运行，没有可修复的审查意见");
  if (task.status === "running" || task.status === "queued") throw new Error("任务正在运行或排队，结束后再发起修复");
  if (task.question || task.resumePrompt) throw new Error("任务正等待答复或续跑，处理后再发起修复");
  // 与即时派审同级的原子互斥：只查 DB status 挡不住「普通回合已 claim、尚未落 running」
  // 的窗口（审查实测：窗口里修复照样 200 并排到那个回合之后）。占位身份 dispatch，
  // 校验与排队注册整段占住；释放后修复消息才可能真正投递，投递回调里再重验一遍锚点。
  // 占到的那把锁的身份一路带到 finally:这中间全是 await,人工放开可以把锁拔走、另一轮
  // 合法占上,按任务 id 还锁撤掉的就是后来者那把(本轮审查 F1,见 turn-lock.ts `endOwnTurn`)。
  const holdingTurn = opts.holdTurn === true;
  const turn = holdingTurn ? claimOwnTurn(taskId, "dispatch") : null;
  if (holdingTurn && !turn) {
    throw new Error("任务回合正在进行，结束后再发起修复");
  }
  try {
    if (!tryAcquireFreeWorkflowAction(taskId)) throw new Error("当前已有自由工作流操作正在进行");
    try {
      if (pendingRepairs.has(taskId)) throw new Error("修复消息已在途，等它开始执行后再操作");
      const subject = await manualRepairSubject(taskId, opts.target ? { ...opts.target, ruled: true } : null);
      if (typeof subject === "string") {
        throw new Error(subject === STALE_SUBJECT
          ? `${subject}；请再派一轮审查，而不是按旧意见修复`
          : subject.endsWith("审查报告不存在或为空") ? `${subject}，无法按意见发起修复`
          : subject.includes("无法确认") ? `${subject}；请再派一轮审查` : subject);
      }
      // 点下老按钮 = 用户维持**这一轮**的审查意见（幂等；已裁定或没驳回过时空转）。
      // 裁定那一路已经自己记过账，这里不再碰任何驳回。
      if (!opts.target) await upholdDisputeOn(taskId, subject.round);
      const target: RepairTarget = { runId: subject.run.id, round: subject.round.round, ruled: !!opts.target };
      await appendTaskTimeline(taskId, noticeLine({ kind: "review.repair", source: "free", round: target.round },
        `已按自由工作流第 ${target.round} 轮审查意见发起修复。`));
      bus.publish({ type: "task.review", taskId });
      pendingRepairs.add(taskId);
      whenTurnIdle(taskId, () => { void deliverManualRepair(taskId, target); });
      // 投递回调真正执行（continueTask 被调）时任务即进入 running；在那之前的窗口全靠
      // pendingRepairs 挡。这里挂一个同队回调来清标记。
      whenTurnIdle(taskId, () => pendingRepairs.delete(taskId));
      return await freeWorkflowState(taskId);
    } finally {
      releaseFreeWorkflowAction(taskId);
    }
  } finally {
    if (turn) releaseTurn(taskId, turn);
  }
}
