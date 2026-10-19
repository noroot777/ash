/**
 * 调度台的**站位**：它此刻还代表不代表这个任务,以及跟着这件事的那几个计时器。
 *
 * 从 `session-consumer.ts` 分出来的一组（那边是「事件消费与回合两半」）。分界线是**谁在
 * 回答哪个问题**：这里只回答「这台说了算吗、它的状态该是什么」,一个事件都不解析。
 *
 * 三件事各有自己的不变量,都写在对应函数头上：
 *   • `setLeadStatus` —— `tasks.status` 是路由门禁和页面按钮的共同真相源,写不进去要重试；
 *   • `retireLead` —— 摘牌是一道**单向闸**,之后这台一个共享产物都不许再写；
 *   • `armIdle` —— 待命够久就把常驻进程收掉,先关 stdin 再给宽限期。
 *
 * 为什么是工厂而不是一组裸函数：这几件事都要问「此刻 leads 里登记的是不是我」—— 那张表
 * 归 `session.js` 持有,只能注进来。
 */
import { Writable } from "node:stream";
import { setTaskStatus } from "../status.js";
import { now } from "../util.js";
import { closeLeadTurns } from "./lead-turns.js";
import { flushSessionNotices } from "./lead-voice.js";
import { persistOrReport } from "./lead-session-writes.js";
import type { Lead } from "./session-types.js";

export const IDLE_MS = Number(process.env.ASH_TEAM_IDLE_MS ?? 30 * 60_000);
const CLOSE_GRACE_MS = 10_000;
const STATUS_RETRY_MS = Number(process.env.ASH_TEAM_STATUS_RETRY_MS ?? 5_000);

export function createLeadStatus({ leads, releasePending }: {
  leads: Map<string, Lead>;
  /** 手上这批待送消息的所有权交回给任务（实现在 team/session.js）。 */
  releasePending: (lead: Lead) => void;
}) {
  /**
   * 写这台调度台的任务状态,**写不进去就一直重试**。
   *
   * 别把它跟 activeMs、endedAt 那些统计混成一种语义。`tasks.status` 是路由门禁、排队投递
   * 和页面按钮的共同真相源:回合已经收了、agentEnd 已经落盘,库里却还写着 running,用户看到
   * 的是「仍在跑/可停止」,依赖 idle 的后续动作也不会推进。而常驻会话跟一次性任务不同 ——
   * 它收完一个回合就阻塞在 events 上,**没有下一个自然的补写时机**:默认要等下一条消息或
   * 30 分钟空闲回收,`ASH_TEAM_IDLE_MS<=0` 时可以永远维持(2026-08-25 第 5 轮审查)。所以这
   * 一笔必须自己带重试,而不是报一声就算完。
   *
   * 报错只报第一次(后面每 STATUS_RETRY_MS 静默重试),那之后再刷屏也不多给用户任何信息。
   */
  async function setLeadStatus(lead: Lead, status: "running" | "idle", at = now()): Promise<void> {
    clearStatusRetry(lead);
    if (lead.retired) return; // 已经不代表这个任务了,状态归接管的那台管
    lead.wantedStatus = status;
    const what = status === "idle" ? "调度台待命状态" : "调度台运行状态";
    if (await persistOrReport(lead, what, () => setTaskStatus(lead.taskId, status), at)) {
      if (lead.wantedStatus === status) lead.wantedStatus = null;
      return;
    }
    armStatusRetry(lead);
  }

  /**
   * 这台调度台从此不再代表这个任务(被新进程接管,或工作目录没了被抛弃)。手上那笔待写状态
   * 就地作废,**所有共享产物一并断开**。
   *
   * 为什么不能只在计时器里查一下 `leads` 有没有人:**map 是空的不等于旧台还有话语权**。
   * 旧台的 running 写失败留下重试 → 新台接管 → 新台正常收尾、写了 idle 并把自己摘牌 →
   * 旧计时器这才到点,看到 map 是空的就把过期的 running 写了回去。这一次比原来那个坑更
   * 难自愈:已经没有任何在线调度台或下一个回合会来覆盖它(2026-08-25 第 6 轮审查)。
   *
   * 共享的不止 tasks.status:接管那条路(工作目录被抽走)**复用同一条会话行,连 .md 都是
   * 同一个文件**(文件名就是 sessId)。旧台晚到的正文、执行诊断和 agentEnd 会插进新台还
   * 没说完的那一段里 —— parseSessionOutput 见到 agentEnd 就收口,一条回复被切成两个气泡,
   * 用时也跟着算错(2026-08-26 第 8 轮审查)。所以这里把写流换成丢弃流:**换而不是 end,**
   * 因为消费循环还在跑,往已经 end 的流里写一个字就是 ERR_STREAM_WRITE_AFTER_END,当场
   * 打崩整个 server。trace 与 SSE 由 traceLead / publish 各自认这块牌子。
   */
  function retireLead(lead: Lead): void {
    if (lead.retired) return; // 摘过一次就够了:再摘一次时新台可能正说到一半,不能往共享 .md 里补写
    lead.retired = true;
    // 摘牌 = 这台的作用域被换掉了,它手上那些回合从此不会再写盘,活动登记跟着撤
    //（第 6 轮审查必须修 1:注销要覆盖「被替换」这个出口,不只正常收尾）。
    // **只撤自己持有的那些**,不是整条会话：接管那条路会复用同一行,新台刚登记的起点不能被
    // 晚到的旧收尾一起清掉（closeLead 的 superseded 分支就是这么进来的）。摘牌之后这台也不
    // 再接受新的持有 —— 晚到的回调开出来的回合谁都不会来收（第 8 轮审查必须修 1）。
    closeLeadTurns(lead);
    clearStatusRetry(lead);
    lead.wantedStatus = null;
    // 手上这批待送消息的**所有权**跟着牌子一起交出去(见 releasePending)。
    releasePending(lead);  // 攒着的轮换旁注必须**在断流之前**落盘。它为了不夹在正文和 agentEnd 之间才缓存下来
    // (见 Lead.notices),可摘牌之后 turnEnd/closeLead 的那次 flush 只会写进丢弃流 ——
    // 「这条会话已作废、下次会丢上下文」这句关键说明就只活在 SSE 里,用户刷新一次就再也
    // 看不到发生过什么(2026-08-26 第 9 轮审查)。
    //
    // 这里不补 agentEnd:摘牌的这一回合本来就不会再有收尾,那条排序约束针对的是正常收尾。
    // 时机也是安全的 —— retireLead 只从同步代码里跑,且都排在新台开口之前(deliver 里先
    // 摘牌再 open,attachLead 里先摘旧台再启动新台的消费循环),插不进别人的正文中间。
    flushSessionNotices(lead);
    const out = lead.out;
    lead.out = new Writable({ write(_chunk, _enc, done) { done(); } });
    out.end();
  }

  function clearStatusRetry(lead: Lead): void {
    if (lead.statusTimer) clearTimeout(lead.statusTimer);
    lead.statusTimer = null;
  }

  function armStatusRetry(lead: Lead): void {
    clearStatusRetry(lead);
    const status = lead.wantedStatus;
    if (!status || lead.retired) return;
    const t = setTimeout(() => {
      lead.statusTimer = null;
      // 摘过牌就永远不再写(retireLead);没摘牌但已经换了新台在线,也是新台说了算。
      const owner = leads.get(lead.taskId);
      if (lead.retired || lead.wantedStatus !== status || (owner && owner !== lead)) return;
      void setTaskStatus(lead.taskId, status)
        .then(() => {
          if (lead.wantedStatus === status) lead.wantedStatus = null;
        })
        .catch(() => armStatusRetry(lead));
    }, STATUS_RETRY_MS);
    (t as { unref?: () => void }).unref?.();
    lead.statusTimer = t;
  }

  // ── 空闲回收 ────────────────────────────────────────────────────────────────
  function clearIdle(lead: Lead): void {
    if (lead.idleTimer) clearTimeout(lead.idleTimer);
    lead.idleTimer = null;
  }

  function armIdle(lead: Lead): void {
    clearIdle(lead);
    if (!(IDLE_MS > 0)) return;
    const t = setTimeout(() => {
      if (lead.busy || lead.pending.length) return; // 刚好又忙起来了
      lead.closing = "recycle";
      try {
        lead.handle.close(); // 关 stdin,让它自己收尾退出
      } catch {
        /* 已经没了 */
      }
      const hard = setTimeout(() => {
        if (leads.get(lead.taskId) === lead) lead.handle.kill();
      }, CLOSE_GRACE_MS);
      (hard as { unref?: () => void }).unref?.();
    }, IDLE_MS);
    (t as { unref?: () => void }).unref?.();
    lead.idleTimer = t;
  }

  return { armIdle, armStatusRetry, clearIdle, clearStatusRetry, retireLead, setLeadStatus };
}
