// 「按意见修复」这一条链:**代发一条带报告链接的修复消息,不翻转任何状态。**
//
// 从 free-workflow.ts 拆出来(本轮审查 F4:那个文件被这一段顶过了单文件 700 行的硬上限)。
// 按职责切:这里是**一次用户动作**的入口 + 它的放行证明 + 投递回调;留在 free-workflow.ts
// 的是审查链自己的状态机(预约、结算、换轮、收尾)。两边唯一的接口就是下面这几个 import。
//
// 这一段自己的不变量都在各函数的注释里,拆文件没有改动其中任何一条。
import { and, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { freeReviewRounds, tasks } from "./db/schema.js";
import { activeDebateOf, debateClosingOf } from "./free-review-debate.js";
import { currentRoundOf, upholdOpenDispute, waivedDisputeOf } from "./free-review-dispute.js";
import { readFreeReviewReport } from "./free-review-files.js";
import { freeManualRepairPrompt } from "./free-review-prompts.js";
import { latestWorkspaceRun, reviewingRun, type ReviewRunRow } from "./free-review-round.js";
import { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } from "./free-workflow-lock.js";
import { freeWorkflowState, workspaceStateOf, type FreeWorkflowApiState } from "./free-workflow-state.js";
import { claimTurn, releaseTurn, whenTurnIdle } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";

// 「按意见修复」按钮 = 代发一条带报告链接的修复消息，**不翻转任何状态**。
// 「修复进行中」的显示靠任务本身 running 推导；修完要不要复审看预约槽。
// 在途标记只防「双击发两条」：消息真正投出（continueTask 开跑）就清掉，之后的重复
// 点击由 running 校验拦。内存即可——重启后排队回调本来就一起丢。
const pendingRepairs = new Set<string>();

/**
 * 「这份未通过报告仍对应当前代码」的完整证明，返回错误文案或 null（可修复）。
 * 入口校验与**投递回调**各跑一遍：入口占着 turn 校验（下面），但修复消息可能排在别的
 * 回合之后才真正投递——那个回合可以改代码，排队前的证明到投递时已经过期，不重验就会
 * 让实现 agent 按旧版报告改新版代码（审查实测：占住 turn 的普通回合结束后旧意见照发）。
 */
async function manualRepairBlocker(taskId: string): Promise<string | null> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return "任务不存在";
  if (task.stage === "accepted" || task.stage === "merged") return "任务已进入验收结果";
  if (await reviewingRun(taskId)) return "审查回合正在进行";
  if (await activeDebateOf(taskId)) return "审查意见辩论正在进行，等它说完再决定";
  // 用户已经裁定「不在本任务里修」的那一轮不能再拿去修：确认框写的是「执行者不再按它
  // 修改」，修复入口却照单放行的话，用户点一下就把自己刚下的裁定推翻了（第 1 轮审查实测）。
  // 转成了独立任务的那档更硬——那几条已经有别的任务在承接，这里再修一遍就是两处各改一版。
  const waived = await waivedDisputeOf(taskId);
  if (waived) {
    return waived.round.disputeResolution === "deferred"
      ? `这一轮意见已被你裁定转为独立任务（${waived.round.disputeDeferredTaskId ?? "待办任务"}），不在本任务里修；要继续推进请再派一轮审查`
      : "这一轮意见已被你裁定作废（采纳了执行者的说法），不再按它修复；要继续推进请再派一轮审查";
  }
  const run = await latestWorkspaceRun(taskId);
  if (!run || run.status !== "stopped") return "最近一轮审查没有停在未通过状态";
  // 报告读取走安全解析（拒 symlink 祖先），且必须有非空正文——raw existsSync 会被
  // 换成 symlink 的 round 目录骗过，把外部路径写进发给实现 agent 的提示。
  if (!readFreeReviewReport(taskId, run.id, run.currentRound).trim()) {
    return "最近一轮审查报告不存在或为空";
  }
  // 只有能**证明**意见仍对应当前代码才放行修复（失败向「不确定」开，不向「没问题」开）：
  // 锚点缺失（老数据）、工作区读不到（已清理/非 git）都无从证明——正确动作是再派一轮
  // 「审查新改动」，而不是按一份无法核对的报告唤醒实现 agent 改代码。
  const concluded = (await db.select().from(freeReviewRounds)
    .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)))).at(0);
  if (!concluded?.reviewedCommit) return "这轮审查缺少基准 commit，无法确认意见仍对应当前代码";
  const workspace = await workspaceStateOf(task);
  if (!workspace.head || workspace.dirty == null) return "工作区不可读，无法确认审查意见仍对应当前代码";
  if (workspace.head !== concluded.reviewedCommit || workspace.dirty) {
    return "审查意见针对的代码已变化（新提交或未提交改动）";
  }
  return null;
}

async function deliverManualRepair(taskId: string, run: ReviewRunRow): Promise<void> {
  const abort = async (message: string) => {
    pendingRepairs.delete(taskId);
    await appendTaskTimeline(taskId, `自由工作流审查意见修复已取消：${message}；请再派一轮审查。`);
    bus.publish({ type: "task.review", taskId });
  };
  try {
    const blocker = await manualRepairBlocker(taskId);
    if (blocker) return void await abort(blocker);
    const { continueTask } = await import("./orchestrator.js");
    // 用户裁定「维持审查意见」之后的这一趟不再给驳回这条路（措辞见 free-review-prompts）。
    // 辩论的收尾发言与用户写的裁定要点也在这里一并带上：前者执行者的会话里结构上没有，
    // 后者是三档裁定表达不了的那部分结论。少任何一边，「辩完达成的共识」都到不了真正
    // 去改代码的那一方，用户点完「让它接着改」只会看到执行者照原报告改。
    const round = await currentRoundOf(run);
    const delivered = await continueTask(
      taskId,
      await freeManualRepairPrompt(taskId, run, {
        disputeUpheld: round?.disputeResolution === "upheld",
        resolutionNote: round?.disputeResolutionNote ?? null,
        debateClosing: round ? await debateClosingOf(round.id) : null,
      }),
      { byBackend: true },
    );
    if (delivered === false) await abort("回合被其它执行抢占，消息未能投递");
  } catch (error) {
    await abort(error instanceof Error ? error.message : String(error));
  }
}

export async function startManualFreeReviewRepair(
  taskId: string,
  opts: { holdTurn?: boolean } = {},
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
  const holdingTurn = opts.holdTurn === true;
  if (holdingTurn && !claimTurn(taskId, "dispatch")) {
    throw new Error("任务回合正在进行，结束后再发起修复");
  }
  try {
    if (!tryAcquireFreeWorkflowAction(taskId)) throw new Error("当前已有自由工作流操作正在进行");
    try {
      if (pendingRepairs.has(taskId)) throw new Error("修复消息已在途，等它开始执行后再操作");
      const blocker = await manualRepairBlocker(taskId);
      if (blocker) {
        throw new Error(blocker === "审查意见针对的代码已变化（新提交或未提交改动）"
          ? `${blocker}；请再派一轮审查，而不是按旧意见修复`
          : blocker === "最近一轮审查报告不存在或为空" ? `${blocker}，无法按意见发起修复`
          : blocker.includes("无法确认") ? `${blocker}；请再派一轮审查` : blocker);
      }
      const run = (await latestWorkspaceRun(taskId))!;
      // 点下修复 = 用户维持审查意见（幂等；已裁定或没驳回过时空转）。
      await upholdOpenDispute(taskId);
      await appendTaskTimeline(taskId, `已按自由工作流第 ${run.currentRound} 轮审查意见发起修复。`);
      bus.publish({ type: "task.review", taskId });
      pendingRepairs.add(taskId);
      whenTurnIdle(taskId, () => { void deliverManualRepair(taskId, run); });
      // 投递回调真正执行（continueTask 被调）时任务即进入 running；在那之前的窗口全靠
      // pendingRepairs 挡。这里挂一个同队回调来清标记。
      whenTurnIdle(taskId, () => pendingRepairs.delete(taskId));
      return await freeWorkflowState(taskId);
    } finally {
      releaseFreeWorkflowAction(taskId);
    }
  } finally {
    if (holdingTurn) releaseTurn(taskId);
  }
}
