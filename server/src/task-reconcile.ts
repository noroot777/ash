// 重启后收拾被打断的任务（从 orchestrator.ts 拆出，纯行数拆分）。
// **必须在 reattachRunningTasks 之后调用**（index.ts 保证顺序），理由见函数注释。
import { eq, inArray } from "drizzle-orm";
import type { TaskStatus } from "@harness/shared";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { isRunning } from "./runs.js";
import { setTaskStatus } from "./status.js";
import { startTeam } from "./team/session.js";
import { reconcileTurnBaseline } from "./turn-baseline.js";
import { now } from "./util.js";

// On (re)start nothing is actually running, so any task still in an in-flight
// status was interrupted (e.g. the server restarted mid-run). Mark those failed
// so they're recoverable via retry/reply instead of being stuck forever.
// awaiting_review is left alone — its gate can still be resolved after a restart.
// 例外一:团队任务(mode:"team")没有「失败」这回事 —— 调度台进程随 server 一起
// 死了,但 CLI 会话还在,下次有人说话就 --resume 接回。落 idle(待命)。
// 例外二:被打断的是续聊回合(followUpFrom 非空)→ 回到续聊前的终态,别把一个
// 早就完成的任务记成 failed。
// **逐个走 setTaskStatus 单点**(而不是一条 UPDATE 批量改):它维护
// startedAt/endedAt、广播 task.status,并且触发队列推进 —— 否则重启把队列 head
// 打成 failed 之后没有任何人去推,整条串行队列就一直停在那等(实测:重启后
// 后面的任务再也不会自动开始,得手点一次「运行分组」)。
export async function reconcileInterrupted(): Promise<void> {
  // **必须在 reattachRunningTasks 之后调用**（index.ts 保证顺序）。被成功接管的
  // 任务此刻有活的 handle，isRunning 为真 —— 它们绝不能再被当成「被打断」判
  // failed：那会让一个正在干活的 agent 在界面上显示失败，用户一点重试就会有
  // 第二个 agent 进同一个 worktree。
  // 用 isRunning（runs.ts，中立模块）而不是回头 import reattach，依赖保持单向。
  const orphaned = (await db.select().from(tasks).where(inArray(tasks.status, ["running", "queued"])))
    .filter((t) => !isRunning(t.id));
  if (!orphaned.length) return;
  const teamIds = orphaned.filter((t) => t.mode === "team").map((t) => t.id);
  const others = orphaned.filter((t) => t.mode !== "team");
  for (const t of others) {
    const back = (t.followUpFrom as TaskStatus | null) ?? "failed";
    if (t.followUpFrom || t.completeConfirmedAt) {
      await db
        .update(tasks)
        .set({ followUpFrom: null, completeConfirmedAt: null, updatedAt: now() })
        .where(eq(tasks.id, t.id));
    }
    // 被打断的回合可能已经走完 write-ahead（基线落盘、验收快照清空）：这里就是它的
    // 结算，必须把基线消费掉——工作目录没动过就整套挂回 stage/合并快照/尾段进度。
    // 只恢复 status 的话，基线躺在磁盘上等下一个真人回合 recordTurnBaseline 直接覆盖，
    // 已验收事实从「暂时不显示」变成永久丢失（审查实测复现）。
    await reconcileTurnBaseline(t.id, false);
    await setTaskStatus(t.id, back);
  }
  for (const teamId of teamIds) await setTaskStatus(teamId, "idle");
  const followUps = others.filter((t) => t.followUpFrom).length;
  console.log(
    `[harness] reconciled ${others.length - followUps} interrupted task(s) → failed` +
      (followUps ? `, ${followUps} follow-up turn(s) → 原终态` : "") +
      (teamIds.length ? `, ${teamIds.length} team task(s) → idle` : ""),
  );
  wakeInterruptedLeads(teamIds);
}

// 被打断在「正在思考/派活」当口的团队调度台，重启后必须主动叫醒一次。
//
// 平时调度台是被执行者事件唤醒的（提问 / 失败 / reportBack 完成，见
// team/inbox.ts）。但如果它被打断时手头那批执行者**已经全部跑完**，就再也没有
// 人会来敲它的门了 —— 它会一直 idle 躺着，只能等用户自己去戳一下。这是重启在
// 团队链路上唯一真正会「卡住」的地方。
//
// 只叫醒 teamIds（重启时正好是 running/queued 的那些，即确实被打断在半途）。
// 本来就 idle 的不动：它没有未竟的一轮，叫它等于白烧一次模型调用。
// startTeam 走的是 deliver → 内存里没有 lead → openLead 的 --resume 接回，
// 调度者会收到「你被中断过」的提示，自己 list_tasks 看现状。
function wakeInterruptedLeads(teamIds: string[]): void {
  if (!teamIds.length) return;
  // 稍等一下再叫：让 server 先把启动流程走完（含上面的接管），调度者一睁眼
  // 看到的执行者状态才是最终的，不会基于半截快照做决策。
  const t = setTimeout(() => {
    for (const teamId of teamIds) {
      void startTeam(teamId).catch((err) =>
        console.error(`[harness] 唤醒被打断的团队调度台 ${teamId} 失败:`, err),
      );
    }
    console.log(`[harness] 已叫醒 ${teamIds.length} 个被打断的团队调度台`);
  }, 3000);
  (t as { unref?: () => void }).unref?.();
}
