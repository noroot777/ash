// 进程已经不在了的那一路收尾:**先把日志里没读过的那段补完**,再落终态。
//
// 从 monitors.ts 拆出来(单文件 700 行的约定),它自成一件事:在线那条收尾(`finish`)手上有
// 进程、有退出码、有一条还在读的 tail;这一条什么都没有 —— 只有一个日志文件和一行 running。
// 所以它得自己把文件吸干、自己判「这一趟读到哪」,而且**两条收尾说的那句话必须一字同源**
// (第 1 轮审查 N2:事件数和「有没有产出过」要给 agent 当面说清,不能只写给人看的时间线)。
//
// 依赖是单向的:这边用 monitors.ts 的运行时与推送,那边一个字都不用回头问这边。
import { and, eq } from "drizzle-orm";
import { monitorEventTally } from "@ash/shared/monitor-silence";
import type { MonitorStatus } from "@ash/shared/monitor";
import { db, dbClient } from "./db/index.js";
import { monitors } from "./db/schema.js";
import { deliverResultHandoff } from "./monitor-events.js";
import { ensureSupervised } from "./monitor-handover.js";
import { tailLines } from "./monitor-spawn.js";
import { hitOf, matchedReason } from "./monitor-consume.js";
import {
  claimFinish, commitProgress, monitorLogBytes, publish, pushLines, serialize, teardownRuntimeLocked,
  type Row,
} from "./monitors.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

/**
 * 进程已经不在了的那一路：**先把日志里没读过的那段补完**，再落终态。
 *
 * 不补的代价是整段工作白跑——而「一件事要跑两小时」恰恰是哨兵存在的全部理由：命令在
 * ash 关闭期间跑完，重启后只看到一句「进程已不在」，那两小时的进展和结束结果一个字都
 * 不会到任务头上（第 1 轮审查复现：日志里有 OFFLINE_DONE，任务一条通知都没有）。
 *
 * 退出码确实拿不到，如实记 null —— 不拿 0 冒充跑成功了。
 */
export async function finishOffline(
  row: Row,
  status: Exclude<MonitorStatus, "running">,
  reason: string,
): Promise<void> {
  // **排进这条哨兵自己的队列,而且在队列里重读一遍**(第 21 轮审查 F2)。这个函数原来只在
  // 开机那一趟被调(那时还没有人能点停),现在恢复梯子也会在任意时刻调它 —— 于是它跟用户
  // 点停、跟删除撞在一起:审查实测到的现场是**点停已经成功返回**(stopped、待发 0 条、理由
  // 是用户明确点停),随后这条在途的旧回调照旧把行写成 `expired` 并补推一条结束通知。
  //
  // 「await 之前读到的 running」不是「await 之后的所有权」:下面每一步(补读、落终态、通知)
  // 都要按**队列里重读到的那一行**判,而且落终态用条件更新 —— 条件没落上就一个字都不写、
  // 一条通知都不推。
  await serialize(row.id, async () => {
    if (dbClient.closed) return;
    const fresh = (await db.select().from(monitors).where(eq(monitors.id, row.id))).at(0);
    if (!fresh || fresh.status !== "running") {
      console.error(`[ash] 离线收尾放手 monitor=${row.id}：队列里重读到的状态是 `
        + `${fresh?.status ?? "行已不在"}，这一刻的结局已经有人写过了（${reason}）`);
      return;
    }
    // **这一笔也要进同一份收尾所有权**(第 1 轮审查 F1)。这条路不走 `finish`,终态是它自己
    // 用条件更新写的 —— 而条件更新只问「还是 running 吗」,问不出「有没有人正握着这条哨兵
    // 还没交出去的行」:在线那笔收尾一进 `drainOwed` 就把运行时摘走了,此刻它手上那几行只活
    // 在它的局部变量里,这里抢先把终态写下去,它重读到终态就只能放手。
    //
    // 占不到就**退出**而不是等:这一整段跑在 `serialize(row.id)` 上,而排干下一批也要排这条
    // 队列 —— 等它等于两边互等。退出是安全的:握着输出的那一笔本来就会把这一行收完(它同样
    // 会撤运行时、补推、落终态),这一趟无非是白跑一遍。
    const release = claimFinish(fresh.id);
    if (!release) {
      console.error(`[ash] 离线收尾让位 monitor=${fresh.id}：已经有一笔收尾在跑（它手上可能还`
        + `握着没送出去的行），由它落终态（${reason}）`);
      return;
    }
    try {
      // **现有运行时在这里交接掉**(第 22 轮审查 N2):接回层现在给每一条运行行都先立 tail 和
      // 期限(连 pid 还空着的创建意图行也有),而这一趟判的就是「它已经不在了」。不撤的话一条
      // 已经写成终态的行还占着文件句柄、还在算自己的期限,到点再走一次收尾。撤之前照旧把
      // 文件吸干、把缓冲推出去(那一批是已经发生的事实)—— 所以下面**重读一遍**:offset 和
      // events 刚被那一次 flush 推进过,照 `fresh` 读会把同一批行再推一次。
      await teardownRuntimeLocked(fresh.id);
      const base = (await db.select().from(monitors).where(eq(monitors.id, fresh.id))).at(0) ?? fresh;

      const collected: string[] = [];
      let readTo = base.offset;
      const tail = tailLines(base.logPath, base.offset, (lines, offset) => {
        for (const line of lines) if (line.trim()) collected.push(line);
        readTo = offset;
      });
      tail.drain();
      tail.stop();

      let events = base.events;
      // 命中那一行的保留是正文构造层的默认契约,这一处**不传**也照样留（第 3 轮审查 N1）。
      if (collected.length) events = await pushLines(base, collected, readTo);
      // 补读出来的全是空行:位置照旧只在「前面都已交付或明确放弃」时才推（文件头 ④ 的判据
      // 在 `commitProgress` 里,这一路运行时刚撤掉,内存里本来就没有没结清的内容）。
      else if (readTo !== base.offset) await commitProgress(base.id, readTo);

      // **补读到的那一行命中,跟在线排干读到的是同一份证据**（新一轮审查 N1 实测:停服期间
      // 日志里已经出现约定的字样,正文补送成功、`events=1`,而卡片上写的仍是「进程已经不在
      // 了」，不是「等到了约定的那一行」）。判据跟在线那一侧同一个函数（`hitOf`）,不在这儿
      // 另写一遍。
      //
      // **只换标签,不抹掉「进程为什么没了」**:这一路从来拿不到退出码（照旧 `exitCode: null`），
      // 而且 ash 不在的时候那个进程是跑完了、被谁杀了、还是机器重启了,只有传进来的那句话答
      // 得出来 —— 所以把它原样接在后面,而不是换掉它（在线那一侧的折叠见 monitor-finish.ts
      // 的 `foldHit`）。只折 `lost` 这一档:别的终态是更确定的事实,不许被一行日志改写。
      const hit = hitOf(base, collected);
      const outcome = hit !== null && status === "lost" ? "matched" : status;
      const note = hit !== null && status === "lost"
        ? `${matchedReason(hit)} —— 这一行是 ash 不在期间补读到的：${reason}`
        : reason;

      // 同上:凭证跟终态一条语句落库(第 1 轮审查 F1 的对称面 —— 离线收尾也是「先结束、后通知」)。
      // **这句话跟在线那条收尾一字同源**(第 1 轮审查 N2):事件数与「有没有产出过」要给 agent
      // 当面说清,不能只写给人看的时间线 —— 它拿到一句光秃秃的结束通知,分不出「哨兵哑了」
      // 和「我漏读了几条」。两处都用这一份 tally,所以读也只读一次。
      const tally = monitorEventTally(events, monitorLogBytes(base.logPath));
      const endNotice = `【哨兵结束】${base.description}（monitorId=${base.id}）。${note}（${tally}）`;
      const result = await db
        .update(monitors)
        .set({
          status: outcome, endedAt: now(), endedReason: note, exitCode: null,
          resultHandoffAt: now(), resultHandoffText: endNotice,
        })
        .where(and(eq(monitors.id, base.id), eq(monitors.status, "running")));
      if (Number((result as { rowsAffected?: number | bigint } | null)?.rowsAffected ?? 0) === 0) {
        // 条件没落上 = 这一瞬有人把它收尾了。**结束通知到此为止**:再推就是在用户已经停掉
        // 之后又叫醒一次任务(补读出去的那几行是已经发生的事实,留着)。
        console.error(`[ash] 离线收尾的条件更新没落上 monitor=${base.id}：结局已经有人写过了`);
        return;
      }
      publish(base.taskId);
      // 同上:问日志文件,不问游标也不问这一趟读到哪(两者都只是「送出去多少」的影子)。
      await appendTaskTimeline(base.taskId, `哨兵结束：${base.description}。${note}（${tally}）`);
      await deliverResultHandoff(base.id);
    } finally {
      // 撤运行时排在读日志之前(自己那条 tail 不停下来就会边收尾边继续推),所以中间这一段
      // 里「监督已撤、终态未落」是真实的一瞬。**出去的时候还是 running 就把监督接回去**
      // (第 23 轮审查 F1 实测:让这条 UPDATE 抛一次,之后产出的结果一条都送不出去、期限
      // 过了也没有结束通知)。`holdingChain`:正跑在 `serialize(row.id)` 上,不能再排一次。
      //
      // 这一趟做不成会**自己排重试**(第 24 轮审查 F1):接回那一步用的是同一个库,它跟着
      // 这次故障一起失败时,光打一行日志就等于把这条哨兵永久丢掉。
      await ensureSupervised(row.id, { holdingChain: true });
      // 监督挂回去之后才交还所有权:中间这一瞬要是让别的收尾进来,它看到的就是「没有运行时、
      // 行还 running」那张老牌面。
      release();
    }
  });
}
