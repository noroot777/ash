// 单飞回合收尾的**结算段**:补录交卷 → 落位 → 基线对账 → 结算钩子 → 通道诊断。
//
// 从 single-run.ts 拆出来(那边到了 700 行上限)。前半段(收流、回收后代、写会话、记回合区间)
// 仍在那边;这里接着往下走,顺序讲究原样保留,各自的理由写在每一步旁边。
//
// `step` 是收尾记步(turn-wind-down.ts):每个 await 之前报一声「走到这一步了」,卡住时巡检才
// 说得出卡在哪一步。它不决定往不往下走 —— 锁只由这一轮自己放,别人拿不走。
import type { WriteStream } from "node:fs";
import type { AgentEvent, AgentType, SessionRole } from "@ash/shared";
import { turnIdentity, type StopSettle } from "./runs.js";
import type { RunHandle } from "./executors/types.js";
import { writeTurnEnd } from "./transcript.js";
import { clearStallFailure, type StallVerdict } from "./turn-stall-verdict.js";
import { clearTurnStart } from "./turn-output.js";
import { reconcileTurnBaseline } from "./turn-baseline.js";
import { replayUndeliveredMcpCalls } from "./mcp-handoff.js";
import { noteReviewerChannelGap, noteTurnChannelGap } from "./review-channel-gap.js";
import { afterSettlement, settleTaskStatus } from "./settle-status.js";
import { persistRunGoal } from "./task-cli-state.js";
import { LONG_WIND_DOWN_STEP_MS, WIND_DOWN_SETTLEMENT_WAIT_MS, windDownWithin } from "./turn-wind-down.js";
import { withExternalWaitBound } from "./external-wait-bound.js";
import { appendTaskTimeline, alertLine } from "./task-timeline.js";
import type { TurnOwner } from "./turn-lock.js";

export type SingleRunSettlement = {
  taskId: string;
  sessId: string;
  agentType: AgentType;
  role: SessionRole;
  turnStart: string;
  handle: RunHandle;
  out: WriteStream;
  endIso: string;
  exitStatus: number;
  stopped: StopSettle | null;
  watchdogFailure: StallVerdict | null;
  executionFailed: boolean;
  doneEvent: Extract<AgentEvent, { kind: "done" }> | null;
  failure: Parameters<typeof noteReviewerChannelGap>[0]["failure"];
  noteSessionNotice: (text: string, at?: string, level?: "notice") => void;
  flushSessionNotices: () => void;
  /** 收尾记步(见文件头)。 */
  step: (name: string, boundMs?: number) => void;
  /** 起跑方占下的那把锁的凭据:结算后续里的站点进度记到它名下。 */
  turn?: TurnOwner | null;
};

export async function settleSingleRunTurn(s: SingleRunSettlement): Promise<void> {
  const { taskId, sessId, agentType, role, out, endIso, exitStatus, stopped, watchdogFailure, executionFailed,
    doneEvent, failure, noteSessionNotice, flushSessionNotices, step } = s;
  // 这一轮有没有「交卷时通道断了」的调用：有就替它补录。**必须排在 settleTaskStatus
  // 之前** —— complete_task 的补录要赶在结算读确认标记之前落库，晚一步，一个干完活的
  // 任务就已经被记成 failed 了（详见 mcp-handoff.ts）。
  step("补录交卷时断掉的 MCP 调用(replayUndeliveredMcpCalls)");
  await replayUndeliveredMcpCalls({
    taskId,
    sessId,
    turnStart: s.turnStart,
    agentType,
  }).catch(() => 0);
  step("保存持续目标(persistRunGoal)");
  await persistRunGoal(taskId, agentType, s.handle, exitStatus, stopped);
  // **结算看的退出码必须反映熔断**。库里那一列(上面刚写的 `exitStatus`)记真实值不动;
  // 结算这一笔得换成非零,因为被我们杀掉的 CLI 报不出非零 —— claude 走信号退出时
  // `claude-stream.ts` 写的是 `code ?? 0`(信号退出 `code` 为 null,于是 0)。照原样交进去,
  // 一个永远连不上上游的回合会走进「exit 0」那几支:本轮早先交过卷就落 done,名下还有活动
  // 哨兵就落 paused —— 时间线上红着写「按失败结算」,任务却显示完成(第 1 轮审查第 2 条)。
  const settleExit = watchdogFailure && exitStatus === 0 ? 1 : exitStatus;
  // 退出码只够让它**不落 done**;要让它别落成「检查点暂停」,得把原因本身交进去 ——
  // 提问 / 续跑指令 / 持续目标那三支都排在非零退出之前,一个留过续跑指令的回合于是显示
  // 「暂停中 + 继续」,而同一轮区间记 failed(第 3 轮审查 F1,已实测)。落位规则仍然只有
  // 结算那一个单点,这里只负责如实报原因。
  step("结算任务状态(settleTaskStatus)");
  const settled = await settleTaskStatus(taskId, settleExit, stopped, sessId,
    // 原因原样交进去:判决自己带着种类,这里不做翻译 —— 两份同义枚举之间的手工映射,加一种
    // 原因时漏掉就会被 `else` 静默吞掉(上一版就是那个形状)。
    watchdogFailure ? { kind: watchdogFailure.kind, detail: watchdogFailure.reason } : null);
  clearStallFailure(sessId, s.turnStart); // 这一轮结算完了,销账(见那个文件里的水位)
  clearTurnStart(taskId); // 只有「未确认 failed」那一支会读它,别的支路在这儿扔掉残页
  // 这一轮到底改没改东西:账在回合开头就清过了,这里只管「白清了要放回去」——
  // 一个字节没改就把游标/轮数/验收阶段原样放回,屋子是临时搭的还顺手拆掉。
  // 只看照片,confirmedDone 只挑那行时间线的措辞(理由见 turn-baseline.ts)。
  // **必须排在 afterSettlement 之前** —— 那一步会拿着游标把这条线往下推,放回晚一步
  // 就会把纯询问回合的游标推乱(详见 turn-baseline.ts)。
  step("对账工作区基线(reconcileTurnBaseline)");
  await reconcileTurnBaseline(taskId, settled.confirmedDone);
  // turnOk = 这一回合本身干净收尾了(没被停、退出码 0、也没有执行器 error 事件)。
  // 跟落位状态不是一回事:旁路
  // 回合(就地验证)的落位是任务原来的终态,只有它说得清这一轮跑成没跑成。
  //
  // 原生命令回合(`/compact`)整段跳过:它是 CLI 本地的一次压缩,没有模型输出、没有
  // 结论 —— 交给结算钩子的话,正在跑的那一轮就地验证会被当成「验完了」收掉(清轮次、
  // 涨轮数、却给不出 verified/verify_failed),自由工作流那边同理。
  if (!settled.nativeTurn) {
    // 这一步里会同步跑完预设工作流的站点线、准备派审的工作目录、排仓库锁做验收合并,正常就可能
    // 很久,所以给长阈值,站点进度逐站记到这一轮名下(turn-wind-down.ts `windDownWithin`)。
    // 里面没自带上限的外部等待(git、仓库锁)圈上时限:到点由这一轮自己放弃那一步、留一条说明,
    // 继续走到自己的放锁出口。被放弃的那一环按它自己的失败出路走(返回失败或抛错,抛错由
    // afterSettlement 接住只记日志),所以这里补一条说明;任务的落位上一步已经定了,这里不改 ——
    // afterSettlement 本来就不许改已结算的状态。
    step("结算后续(afterSettlement)", LONG_WIND_DOWN_STEP_MS);
    const gaveUp: string[] = [];
    await windDownWithin(taskId, s.turn, LONG_WIND_DOWN_STEP_MS, () => withExternalWaitBound(
      { ms: WIND_DOWN_SETTLEMENT_WAIT_MS, onTimeout: (what) => gaveUp.push(what) },
      () => afterSettlement(
        taskId,
        settled.status,
        settled.confirmedDone,
        !stopped && !executionFailed,
        role,
        !!doneEvent,
        executionFailed,
      ),
    ));
    if (gaveUp.length) {
      step("交代结算后续里被放弃的等待(appendTaskTimeline)");
      await appendTaskTimeline(taskId, alertLine(
        `这一轮收尾时，结算后续里有 ${gaveUp.length} 处等外部东西超过时限，已由这一轮自己放弃：${gaveUp.join("；")}。`
        + "任务状态不受影响；受影响的是这一轮之后本该自动接上的那一环（派审、预设工作流的站、验收合并），"
        + "它没有走完，需要的话手动再触发一次。",
      ));
    }
  }
  // 审查旁路回合没给出结论：把真实原因说出来（中途断了 / 收尾了却没上报，review-channel-gap.ts）。
  // **排在 afterSettlement 之后** —— 那一步里自由工作流才写下「未能正常给出结论，已停止
  // 自动链」，这一句紧跟其后才读得通（先结果、后原因）。说不出来就什么都不说，绝不因此
  // 影响这一轮的落位。
  if (role === "reviewer") {
    // 回合身份在结算期间还占着（orchestrator 在 consumeSingleRun 之后才 releaseTurn），
    // 这一轮绑的是哪一次审查就从那里整份读。
    const review = turnIdentity(taskId)?.review ?? null;
    step("审查通道诊断(noteReviewerChannelGap)");
    await noteReviewerChannelGap({ taskId, sessId, turnStart: s.turnStart, agentType, stopped: !!stopped, review, failure })
      .catch((error) => { console.error(`[ash] noteReviewerChannelGap(${taskId}) failed:`, error); return false; });
  }
  if (settled.note) {
    // 结算说明落成**会话旁注**（持久 system 行 + SSE），跟会话轮换旁注同一条道：
    // 它讲的是「这一轮为什么落成这个状态」，不是 agent 干的活，也不是执行器报的错。
    // 从前它是「.md 里一段引用 + trace 里一条 error」，两处毛病都实打实：引用块糊进
    // agent 气泡正文（实时那份还没有，刷新后才冒出来），error 则把回合折叠条整条染红、
    // 计进「N 异常」—— 第一次用 ash 的人看到的是一个红色黑盒，读到的是「它崩了」，而
    // 真相多半只是「忘了调 complete_task」。真出故障时它还会盖住原因（docs/incidents.md
    // 「接力到多用户机器」）。
    // level:"notice" 让展示端直接知道这是提示不是故障，不必再靠关键词猜语气。
    noteSessionNotice(settled.note, endIso, "notice");
  }
  writeTurnEnd(out, endIso); // fence this turn's real end before closing the .md
  flushSessionNotices();
  out.end();
  // 普通回合 exit 0 却没交卷：会话证据点名 ash MCP 没连上时，把原因接在结算说明后面说出来
  // （先结果、后原因；只认确定证据，见 review-channel-gap.ts 的 noteTurnChannelGap）。
  if (role !== "reviewer" && settled.failureReason === "missing_completion_confirmation") {
    step("交卷通道诊断(noteTurnChannelGap)");
    await noteTurnChannelGap({ taskId, sessId, turnStart: s.turnStart, agentType })
      .catch((error) => { console.error(`[ash] noteTurnChannelGap(${taskId}) failed:`, error); return false; });
  }
}
