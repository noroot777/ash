// 窄出口(`GET /sessions/:id/notices`)的模型。它要回答的只有一句话:**这条会话此刻有没有
// 卡在一条过程提示上**(上游在重试、还在等回话)。读不动整份 trace 的消费者靠它活着 ——
// 手机端每几秒拉一次,而 trace 连工具的完整输入输出一起落盘,最大的一份 8 MB。
//
// 这里是**两种投影**,刻意不合成一个:
//
// ① 此刻还在等(`sessionWaiting`)—— 只在内存里,由事件消费链顺序维护。为什么不能从落盘
//    产物反推:正文先写 `.md`,要到下一条非正文事件才冲进 trace(single-run 与 team 的
//    pendingTraceText 都是这个缓冲),于是照 trace 判就会在整段恢复回答期间一直说「正在
//    重试」,而用户手机上明明已经在读那段回答了(第 3 轮审查 F2)。事件到达那一刻这件事
//    是确定的:提示来了就是在等,下一条有效输出来了就不是了。代价说在明处 —— ash 重启后
//    内存里这份没了,在飞的那一轮回空;等待是转瞬状态,宁可不显示也不该靠猜。
//
// ② 失败现场(`failedTurnNotices`)—— 从 trace 回放,因为它要活过刷新和重启。判据是
//    「这一轮有没有明确的失败结局」,**不是「进程退没退」**(见函数自己的注释)。
import type { AgentEvent, SessionNotice } from "@ash/shared";
import { resumesWaiting } from "@ash/shared/waiting";
import { isExecutionNotice } from "./session-notice.js";
import type { SessionTraceEntry } from "./transcript.js";
import { now } from "./util.js";

// 一条会话上最多留这么多条(只留最近的)。上游连环重试能刷出几十条,而这个出口要答的是
// 「现在卡住了没有」,不是完整流水 —— 完整流水在 trace 自己那份里。
const NOTICE_LIMIT = 50;

type Waiting = { turnStartedAt: string; notices: SessionNotice[] };
const waiting = new Map<string, Waiting>();

/**
 * 事件消费链上的每一条 agent 事件都过这里:过程提示置上,随后任何有效输出置回。
 *
 * `turnStartedAt` 给 null = 这一刻还没有回合身份(自发回合的第一条事件之前):提示照旧不记
 * —— 它在执行过程里也没有落点,记下来只会挂在一个与它无关的回合名下。
 */
export function trackSessionWaiting(sessionId: string, turnStartedAt: string | null, event: AgentEvent): void {
  if (event.kind === "error" && isExecutionNotice(event)) {
    if (!turnStartedAt) return;
    const held = waiting.get(sessionId);
    const notices = held?.turnStartedAt === turnStartedAt ? held.notices : [];
    waiting.set(sessionId, {
      turnStartedAt,
      notices: [...notices, { at: now(), turnStartedAt, text: event.message }].slice(-NOTICE_LIMIT),
    });
    return;
  }
  // 解除条件共用 shared 那一份(真故障也算解除:这一轮不再「在等」了,它另有去处)。
  if (resumesWaiting(event)) waiting.delete(sessionId);
}

/** 这条会话收尾/换台了:等待状态跟着作废(回合收口由 turnEnd 事件自己带到)。 */
export function clearSessionWaiting(sessionId: string): void {
  waiting.delete(sessionId);
}

/**
 * 这条会话此刻还在等的那几条提示。`turnStartedAt` 传会话行上的当前回合:不一致就当没有
 * —— 上一轮崩在半路(没有 turnEnd、没有 done)时内存里那份会留着,它不该成为新回合的状态。
 */
export function sessionWaiting(sessionId: string, turnStartedAt?: string | null): SessionNotice[] {
  const held = waiting.get(sessionId);
  if (!held) return [];
  if (turnStartedAt && held.turnStartedAt !== turnStartedAt) return [];
  return held.notices;
}

/**
 * 这一轮**真的收在失败上**时,它的过程提示 —— 失败现场。
 *
 * 用户的原话是「如果不是最终导致整个会话失败、本条命令执行成功了,就没必要显示在会话结尾
 * 处」,所以反过来:真失败时这几句话就是现场,必须照给,而且要活过刷新,因此只能从 trace 读。
 *
 * 判据是**这一轮有没有明确的失败结局**:
 * - `exitStatus === null` = 还没有退出结果。常驻调度台每一轮健康收尾都会写 `endedAt`,
 *   而进程还在跑(`team/session-consumer.ts` 的 endTurn),拿「不是 0」当失败证明,一台
 *   答完待命的调度台就会在手机上重新挂出整轮的「正在重试」(第 3 轮审查 F1)。
 * - `stoppedAs` 有值 = 这一轮是**被停的**,不是它自己崩的。CLI 吃 SIGTERM 后按 signal
 *   写非零退出码,光看 exitStatus 两者一模一样(single-run.ts 为此单独落了这一列)。
 */
export function failedTurnNotices(
  entries: SessionTraceEntry[],
  session: { turnStartedAt?: string | null; exitStatus: number | null; stoppedAs?: string | null },
): SessionNotice[] {
  const turn = session.turnStartedAt;
  if (!turn) return [];
  if (session.exitStatus === null || session.exitStatus === 0 || session.stoppedAs) return [];
  const out: SessionNotice[] = [];
  for (const entry of entries) {
    if (entry.turnStartedAt !== turn) continue;
    const event = entry.event;
    if (event.kind !== "error" || !isExecutionNotice(event)) continue;
    out.push({ at: entry.at, turnStartedAt: entry.turnStartedAt, text: event.message });
  }
  return out.slice(-NOTICE_LIMIT);
}
