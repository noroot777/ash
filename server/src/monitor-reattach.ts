// **重启接回,以及「这一刻认不回来」那一行的恢复接管** —— 从 monitors.ts 拆出来的那一摊。
//
// 拆出来有两个理由:行数(单文件 700 行的约定,monitors.ts 已经顶到 658 行),以及它自己就是
// 一件完整的事 —— **一条哨兵在 ash 不在的那段时间里发生了什么,现在归谁管**。运行时那一摊
// (tail、缓冲、定时器、推事件)仍然只有 monitors.ts 一份,这里只调它的 `attach`/`finish`。
//
// 这个文件里的不变量:
//  ① 认不出来 ≠ 它不在了 —— 问不出来的那几档照旧接回来(第 6、7 轮审查 F1);
//  ② 接回也是一道**出口资格**判断,不只是认人(第 3、4 轮审查 F1);
//  ③ **「这一刻认不回来」不是终态**:行原样留着,而且**这一次启动周期内自己还要再问**
//     (第 19 轮审查 F2 留的那半件事、第 20 轮审查 F2):光留一行 running 不等于还在盯 ——
//     tail 没接上、期限没人管、认领也没人再问,结果早就出来了界面还一直显示「在等」。
//  ④ **认领可以有界,监听寿命不行**(第 21 轮审查 F1)。上一版把两件事绑在同一条梯子上:
//     梯子是这一行唯一的监督者,于是某一跳 await 抛错、或者五档问完仍认不回来,日志和期限
//     就一起没人管了 —— 审查实测:故障早就过去、结果早就写进日志、期限也过了,行还停在
//     `running/offset=0/events=0`,待发 0 条。所以现在**先接运行时(tail + 期限),再问身份**:
//     `attach` 对 pid 还空着的行只装前两件(探活那一根要等号认回来才补,见 monitors.ts),
//     梯子只负责「把号认回来」这一件,它停不停都不影响日志和到期。
//  ⑤ **后台认领要参加同一份资源所有权协议**(第 21 轮审查 F2)。梯子跑在任意时刻,会跟用户
//     点停、跟删除撞上:await 之前读到的 running 不是 await 之后的所有权。审查实测:点停
//     已经成功返回(stopped、待发 0 条),在途的旧回调照旧把行写成 expired 并补推一条结束
//     通知。所以每一跳都排进停止/创建/删除那同一条 `task:<id>` 队列,并在队列里重读 ——
//     三个出口(接管 / 判掉 / 到期)一个都不许按旧行下结论。
import { and, eq } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { monitors, tasks } from "./db/schema.js";
import {
  adoptSpawnIdentity, clearPendingIntentNote, notePendingIntent, type AdoptOutcome,
} from "./monitor-adopt.js";
import { reclaimMonitorProcess, settleReclaim, type ReclaimVerdict } from "./monitor-reclaim-debts.js";
import { reclaimState, type ReclaimState } from "./monitor-reclaim-evidence.js";
import { monitorWakeGate } from "./monitor-session.js";
import { clearSpawnIdentity } from "./monitor-spawn.js";
import { attach, finish, finishOffline, isAshKind, serialize, type Row } from "./monitors.js";
import { IS_WINDOWS } from "./platform.js";

/**
 * 开机把上一个 server 留下的哨兵接回来。进程本来就没跟着死（这是整件事的全部意义），
 * 所以这里要做的只有两件：确认那个 pid 还是当初那个进程，然后从 `offset` 接着读。
 * 重启那几十秒里产出的行都还在文件里，一条不漏。
 *
 * 认不出来的（进程没了、或 pid 被别人复用了）落 `lost`，但**落之前先把它留下的输出读完**：
 * 「进程不在了」说的是这一刻，不是说它这段时间什么都没干。
 *
 * **接回也是一道资格判断,不只是认人**(第 3、4 轮审查 F1):事实已经落库、而回收那一刀还
 * 没落下去就崩了的话,照着「同代还活着 + 没到期」接回来的是一个**已经没有出口**的命令 ——
 * 它推的每一条都会被出口闸拒回,一直烧到自己到期。所以这里问的就是出口那一份资格本身
 * (`monitorWakeGate`:归档、任务终态、来源审查那一轮还在不在),而不是挨个补某一种 reason。
 */
/**
 * 这一行**现在**还有出口吗 —— 跟创建、事件出口共用 `monitorWakeGate`(见 monitor-session.ts)。
 *
 * 任务行都没了是另一回事:那是删除中途崩了的残留,接回来谁也叫不醒。
 */
async function reattachBlockedReason(row: Row): Promise<string | null> {
  const task = (await db
    .select({ id: tasks.id, status: tasks.status, archived: tasks.archived })
    .from(tasks)
    .where(eq(tasks.id, row.taskId))).at(0);
  if (!task) return "它的任务已经不在了";
  return monitorWakeGate(task, { reviewRun: row.sourceReviewRun, reviewRound: row.sourceReviewRound });
}



/** 「责任到底留下来了没有」那一句尾巴 —— 接回这两条路共用,措辞只有这一份。 */
const owingNote = (verdict: ReclaimVerdict): string =>
  verdict === "closed"
    ? "；原进程的线索随后都追空了"
    : verdict === "owed"
      ? "；原进程退出未确认，已记下回收责任（开机会再收一次）"
      : "；原进程退出未确认，而回收责任尚未保存（见 server 日志里的 pid，仍在重试落盘）";

/**
 * 接回的三档计数。`pending` 是**pid 还空着、这一刻又认不回来**的那几条:行原样留着
 * (见 `notePendingIntent`),所以它既不算接回来了、也不算没了 —— 混进任何一边都是撒谎。
 */
export async function reattachMonitors(): Promise<
  { attached: number; lost: number; pending: number; failed: number }
> {
  // 只认 ash 自己起的：claude 的投影行没有 pid，拿去问身份必然认不出来，会被
  // 整批误判成 lost——而它们此刻多半还在 agent 那边好好跑着。它们的真实归宿由
  // `loseClaudeMonitorsOfSession` 在 agent 进程真的结束时统一收口。
  const rows = await db.select().from(monitors).where(and(eq(monitors.status, "running"), isAshKind));
  let attached = 0;
  let lost = 0;
  let pending = 0;
  let failed = 0;
  for (const stored of rows) {
    // **输出与期限先立起来,一个前提都不附**(第 22 轮审查 F1-A)。这两件跟身份、跟出口资格
    // 都不相干 —— 日志是我们自己的文件,期限是我们自己承诺的 —— 所以它们装在身份那一问
    // 之前、`try` 之外:下面哪一步抛错都带不走它们。`attach` 是幂等的(已经在盯的不重挂,
    // 只补缺的那一份),所以这一句对 `takeOver` 后面那几句 `attach` 没有任何影响。
    attach(stored);
    try {
      const outcome = await recoverOne(stored);
      if (outcome === "attached") attached += 1;
      else if (outcome === "lost") lost += 1;
      else if (outcome === "pending") pending += 1;
    } catch (e) {
      // **逐条隔离**:上一版一抛就整批退出 —— 它后面那些行连 tail 都没接上,而启动侧只打
      // 一行日志就继续启动(index.ts),于是这一次启动期间它们完全没人管(审查实测:两条
      // 哨兵都 `supervised=false`、期限早就过了、结果已经写进日志却一条通知都没有)。
      // 现在这一条的失败只影响这一条:监督上面已经立好,接管那一趟交给有界的恢复重试。
      console.error(`[ash] 接回这一行时出错,交给恢复重试 monitor=${stored.id}:`, e);
      scheduleRecoveryRetry(stored.id);
      failed += 1;
    }
  }
  return { attached, lost, pending, failed };
}

/**
 * **一条行的接回那一趟**:认身份 → 问出口资格 → 接管 / 判掉。
 *
 * 监督(tail、期限)不在这个函数的职责里 —— 调用方在它之前就立好了,所以这里每一步都可以
 * 放心抛:抛出去只丢「这一趟结论」,不丢「有人在盯」(第 22 轮审查 F1-A)。
 */
async function recoverOne(stored: Row): Promise<"attached" | "lost" | "pending" | "ended"> {
    let row = stored;
    // **「问不出来」要跟「它不在了」分开**(第 6 轮审查 F1)。`unknown` = ps 这一问自己失败
    // 了,那就什么都不许声称:**照旧接回来**。这样它仍然在界面上、仍然能被点停、日志还在
    // 收,而 ps 恢复之后探活那一问会自己把结果判出来(见 `attach` 里的 liveness)。原来这里
    // 按一个布尔一刀切,ps 短暂不可用就把一条还活着的哨兵写成「这个进程已经不在了」——
    // 既在界面上撒谎,又让它从此无法叫停。同一个错还有第二种犯法:身份比较自己去补一次
    // 查询,**第二次**失败时被写成确证的 `not-ours`(第 7 轮审查 F1,现在判定收在
    // `processIdentity` 一次快照里)。
    // **pid 是空的**:那是创建协议留下的意图行 —— 身份先落库、进程后起、pid 回填(见
    // monitor-create.ts 文件头)。重启后还能看见它,说明 ash 恰好死在「落了身份」和「回填
    // pid」之间。这一档**既不能按「线索追空」一笔带过,也不能冒充已经收干净**:
    //  · POSIX:命令从未开工 —— 它停在放行闸前等 ash 写一个字节,ash 一死写端就关了,壳
    //    读到 EOF 在 exec 之前自己退掉(exit 97)。所以这条行可以干净地判掉。
    //  · win32:那一侧没有闸(`cmd.exe` 里没有可靠的「从第 3 号句柄读一行」写法),命令可能
    //    已经在跑,而我们手里没有任何 pid 可以去认它 —— 照实说成「认不回来」。**未在
    //    Windows 真机验证**(根 AGENTS.md)。
    if (!row.pid) {
      const adopted = await adoptSpawnIdentity(row);
      // 认不下来的几种事实由 `adoptSpawnIdentity` 带回来(`why` / `settled` / `candidate` /
      // `refusal`)。**`settled: false` 不是终态**(第 19 轮审查 F2):只是**这一刻核实不了**
      // (身份边条或反证账本读不出来),一个字都不许说成「它不在了」(第 6 轮审查 F1 的同一条),
      // 更不许把这一行写成一个此后谁都不会再问第二遍的档。
      //
      // **「原样留着」也不等于还在盯**(第 20 轮审查 F2):光写一行 running —— tail 没接上、
      // 期限没人管、认领也没人再问。结果早就写进日志了,界面却一直显示「在等」,到点连到期
      // 通知都没有(审查实测:等 31 秒仍 `running/pid=null/offset=0/events=0`、待发 0 条,
      // 只有脚本自己再跑一次启动接回才恢复)。所以这一档**在这一次启动周期里自己还要再问**:
      // 挂一条有界的恢复梯子,见 `scheduleRecoveryRetry`。
      if (!adopted.identity && !adopted.settled) {
        await notePendingIntent(row, adopted.why);
        // 监听已经由调用方立好了(tail 和期限跟「认不认得回它的号」无关)。这里只负责「再
        // 问一遍号」:挂一条有界的恢复重试。
        scheduleRecoveryRetry(row.id);
        return "pending";
      }
      if (!adopted.identity) {
        await writeOffIntent(row, adopted);
        return "lost";
      }
      // 认回来了:下面按正常身份走(接回 / 收尾 / 记责任),不再有特殊分支。
      row = { ...row, pid: adopted.identity.pid, pidStartedAt: adopted.identity.pidStartedAt };
      // **号到手就把退出检查那一根补上**,不等下面那一趟接管成功(第 22 轮审查 F1-B):接管
      // 要先问出口资格(读任务行),那一问失败过的现场里,探活一直没装、进程退了也没人收。
      attach(row);
    }
    return await takeOver(row);
}

/** 认不下来的那一支(`identity: null`)—— 接回和恢复梯子两处都按它分档。 */
type AdoptRefused = Extract<AdoptOutcome, { identity: null }>;

/**
 * **身份到手之后的那一趟**:接上 / 判它没出口 / 到期收掉 / 身份对不上就记责任。
 *
 * 抽成函数是因为现在有**两个**入口(第 20 轮审查 F2):开机那一遍,以及待认领意图的恢复梯子
 * 在故障过去之后认回来的那一刻。两处必须走同一份判据 —— 梯子那边自己写一遍的话,出口资格、
 * 期限、记责任这三件事总有一件会漏。
 */
async function takeOver(row: Row): Promise<"attached" | "lost" | "ended"> {
  const state = reclaimState(row.pid!, row.pidStartedAt, row);
  // `unverifiable`(当初没记下启动时刻 / 边条认回来时 ps 不可用)跟 `unknown` 同一档处理:
  // **什么都不许声称,所以照旧接回来**。它仍然在界面上、仍然能被点停、日志还在收,而
  // 「不敢下刀」这件事由回收层那一侧保证(第 9 轮审查 F3)。写成 `lost` 反而是撒谎。
  if (state === "ours-alive" || state === "unknown" || state === "unverifiable") {
    // 它还有出口吗(归档 / 任务终态 / 起它的那次审查那一轮还在不在)。没有就收掉,别接回来
    // 继续烧。先接上再收尾:attach 把 tail 建起来,finish 的 drain 才读得到停服期间那一段,
    // 也由它负责杀进程。
    const blocked = await reattachBlockedReason(row);
    if (blocked) {
      attach(row);
      await finish(row.id, "stopped", `${blocked}（server 重启期间发生的）`, null);
      return "lost";
    }
    if (new Date(row.expiresAt).getTime() <= Date.now()) {
      // 先接上再收尾：attach 把 tail 建起来，finish 的 drain 才读得到停服期间那一段；
      // 它同时负责把这个还活着、但已经超时的进程杀掉。
      attach(row);
      await finish(row.id, "expired", "盯满了约定的时长（server 重启期间到期）", null);
      return "ended";
    }
    attach(row);
    return "attached";
  }
  // 剩下几档各有各的说法,**不能共用一句话**(措辞见 `offlineReason`):`traceless` 线索追空
  // 了;`not-ours` 这个号现在是别人的(原来那个退没退证明不了);`suspected` 文本里还看得见
  // 这次创建的记号、但证不出在谁身上;`ours-orphans` 组长退了、组里还有后代。除了第一档
  // 都要先把回收责任记下来(判据见 reclaimMonitorProcess 那张表)。
  const outcome = await reclaimMonitorProcess({ ...row, pid: row.pid! }, "server 重启后它的身份对不上");
  // **先拿到最终 verdict,再写文案。** 这里不等补刀(deadline 0:只问一次状态,别把开机
  // 吊住),所以把它提到写卡片之前不会让启动变慢 —— 但顺序反过来就会写下一句假话:上一版
  // 无论结果是什么都先把「已记下回收责任」写进卡片,而债表写失败(`unaccounted`)时那句话
  // 只在 server 日志里被纠正过,卡片上那句肯定会一直留着(第 7 轮审查 N1)。责任落盘之后
  // 的推进交给紧随其后的 `reclaimUnconfirmedStops` / `sweepMonitorReclaimDebts` 和梯子。
  const verdict = await settleReclaim(outcome, 0);
  if (verdict === "unaccounted") {
    console.error(`[ash] 接回时既没确认退出、回收责任也没落库 monitor=${row.id} pid=${row.pid}`);
  }
  await finishOffline(row, "lost", offlineReason(state, owingNote(verdict)));
  return "lost";
}

/**
 * `settled` 那一支:**当初那个壳一定不在了**(没留边条 / 反证过 / 那个号现在是另一个进程)。
 *
 * 这一档 **win32 与 POSIX 的事实不同**,措辞和责任都跟着分开:
 *  · POSIX:放行闸证明命令压根没开工 ⇒ 干净判掉,顺手把边条作废 —— 留着它只会让后面的层拿
 *    一个已经被反证的号去记一笔永远收不掉的责任;
 *  · win32:那一侧没有闸,壳派生的命令可能还在跑,而边条上那个号是**唯一的落点线索** ⇒ 责任
 *    照记(候选号拿不到启动时刻,所以落在 `unverifiable` 档:记责任、不下刀)。**未在 Windows
 *    真机验证**(根 AGENTS.md)。
 */
async function writeOffIntent(row: Row, adopted: AdoptRefused): Promise<void> {
  let owing = "";
  if (IS_WINDOWS && adopted.candidate) {
    const outcome = await reclaimMonitorProcess(
      { ...row, pid: adopted.candidate.pid, pidStartedAt: null },
      "server 重启后只认得出身份边条上那个号",
    );
    owing = owingNote(await settleReclaim(outcome, 0));
  } else if (!IS_WINDOWS) {
    clearSpawnIdentity(row.logPath);
  }
  await finishOffline(row, "lost", (IS_WINDOWS
    ? `server 重启后认不回它了：起进程时没来得及记下 pid${adopted.why}，这台机器上没有放行闸，当初那个壳已经不在、但它派生的命令可能还在后台跑着（日志路径见这一行）`
    : `server 重启后判定它没有真正开工：起进程时没来得及记下 pid${adopted.why}，命令停在放行闸前面就退了`) + owing);
}

// ── 待认领意图的恢复梯子 ────────────────────────────────────────────────────

/**
 * 重问**身份**的间隔。**有界**:故障多半是一瞬间的(一句 SELECT 失败、ps 这一刻不可用),所以
 * 前几档贴得很近;一直问不出来时拉开,最后一档之后就不再自己问 —— 把话写回卡片,等下一次
 * 启动、点停或删除(那几条路都会重新问一遍,见 monitor-reclaim 的枚举)。
 *
 * **有界只对「问号」这件事成立**(第 21 轮审查 F1):日志和期限不在这条梯子名下,它们从 pending
 * 落下的那一刻就由运行时接走了,梯子问完五档也照样有人管到期。
 *
 * 跟回收那一侧的梯子(monitor-reclaim-debts 的 `LADDER_MS`)同一个形状:`unref` 定时器,不吊住
 * 进程退出。
 */
const PENDING_LADDER_MS = [1_000, 5_000, 20_000, 60_000, 180_000];
const ladders = new Map<string, NodeJS.Timeout>();

/** 撤掉所有恢复梯子(测试台子和 `detachAllMonitors` 用:库要关了,别让它醒过来问一个关了的库)。 */
export function stopRecoveryRetries(): void {
  for (const [, timer] of ladders) clearTimeout(timer);
  ladders.clear();
}

/**
 * 给一条「这一刻认不回来」的创建意图排下一次**问身份**(第 20、21 轮审查 F2/F1)。
 *
 * 它只负责一件事:**把号认回来**。日志和期限不在它名下 —— 那两件在 pending 落下的同一刻就
 * 由运行时接走了(见上面 `reattachMonitors` 里的 `attach`),所以这条梯子停在哪一档、某一跳
 * 有没有抛错,都不影响「结果送得到、到点收得掉」。
 *
 * **一个信号都不因此多发**:认领的判据一个字没松(`adoptSpawnIdentity` / `reclaimEvidence`),
 * 梯子只是把「再问一遍」这件事自动化。
 */
export function scheduleRecoveryRetry(monitorId: string, step = 0): void {
  const existing = ladders.get(monitorId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    ladders.delete(monitorId);
    void retryRecovery(monitorId, step).catch((e) => {
      console.error(`[ash] 待认领哨兵重问身份时自己出错 monitor=${monitorId}:`, e);
      // **一次抛错不许把身份这一问整条掐掉**(第 21 轮审查 F1):库忙了一下、ps 抖了一下都
      // 会走到这里,而这一行的号还没认回来。照档位往下排(仍然有界),到顶就停。
      if (step + 1 < PENDING_LADDER_MS.length) scheduleRecoveryRetry(monitorId, step + 1);
    });
  }, PENDING_LADDER_MS[Math.min(step, PENDING_LADDER_MS.length - 1)]);
  (timer as { unref?: () => void }).unref?.();
  ladders.set(monitorId, timer);
}

const readRow = async (monitorId: string): Promise<Row | undefined> =>
  (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);

/**
 * 重问一次身份。**整跳都排在 `task:<id>` 那条队列里**,而且队列里重读 —— 停止、创建、删除
 * 走的就是这一条队(见 monitors.ts 的 `stopMonitor`、monitor-reclaim.ts 的
 * `stopMonitorsForTask`),第 21 轮审查 F2 实测的就是不排队的后果。
 */
async function retryRecovery(monitorId: string, step: number): Promise<void> {
  if (dbClient.closed) return;
  const before = await readRow(monitorId);
  if (!before) return;   // 行已经被删掉了:梯子到此为止
  await serialize(`task:${before.taskId}`, async () => {
    if (dbClient.closed) return;
    const row = await readRow(monitorId);
    // 别人已经有结论了(点停、删除、到期收尾)⇒ **一个字都不写、一条通知都不推**。
    if (!row || row.status !== "running") return;
    if (row.pid !== null) {
      // 号已经在列上了:上一跳认回来了,而接管那一步抛了错。
      //
      // **「有一个运行时」也不等于「监督齐了」**(第 22 轮审查 F1-B):pending 那一刻接上的
      // 只有 tail 和期限,而 `isSupervised` 只答「有没有运行时」—— 上一版拿它当闸,于是唯一
      // 能补装探活的那一句被永久挡在门外(实测:进程真的退了,行还停在 running、一条结束
      // 通知都没有)。`attach` 自己就认得出缺哪一份,所以这里**无条件**再调一遍。
      attach(row);
      // 接管那一趟也重试:出口资格、期限、记责任三件事上一跳没走完。它幂等 —— 还活着且
      // 有出口就只是再 `attach` 一次;没出口或已到期就在这里收掉。再抛由梯子的 catch 接。
      await takeOver(row);
      return;
    }
    const adopted = await adoptSpawnIdentity(row);
    // `adoptSpawnIdentity` 自己也 await 了库(账本、取证)。那几毫秒里点停可能已经走完 ——
    // 所以**下结论之前再读一遍**,三个出口共用这一次重读。
    const after = await readRow(monitorId);
    if (!after || after.status !== "running") {
      console.error(`[ash] 待认领哨兵的身份问出来了,但这一刻它已经有结局了 monitor=${monitorId}`
        + `（状态 ${after?.status ?? "行已不在"}）：这一跳什么都不写`);
      return;
    }
    if (adopted.identity) {
      // 认回来了:受阻那句话跟着作废(第 21 轮审查 N1 —— 卡片上不许留一句「正在重问」)。
      const claimed = {
        ...after, pid: adopted.identity.pid, pidStartedAt: adopted.identity.pidStartedAt,
      };
      // **退出检查当场补上,不等接管那一趟成功**(第 22 轮审查 F1-B):接管第一步要读任务行
      // 问出口资格,那一问失败过的现场里,探活一直没装 —— 进程退了也没人收,行一直停在
      // running 等到原期限。能力修复和完成接管是两件事,前者不该押在后者先成功上。
      attach(claimed);
      await clearPendingIntentNote(monitorId);
      await takeOver(claimed);
      return;
    }
    if (adopted.settled) {
      await writeOffIntent(after, adopted);
      return;
    }
    // 还是认不回来。**到期不在这里管**(第 21 轮审查 F1):运行时那一份期限定时器照常走,
    // 到点由 `finish` 收尾(补读日志、按档位留责任、照实写文案)。
    if (step + 1 >= PENDING_LADDER_MS.length) {
      await notePendingIntent(after, adopted.why, { exhausted: true });
      return;
    }
    await notePendingIntent(after, adopted.why);
    scheduleRecoveryRetry(monitorId, step + 1);
  });
}

/**
 * 接回时判不回来的那几档,各自那一句话。**分开写**是因为它们是不同的事实,而这句话会留在
 * 卡片上(第 7 轮审查 N1:卡片上的话不许被 server 日志「纠正」)。
 */
function offlineReason(state: ReclaimState, owing: string): string {
  if (state === "traceless") return "server 重启后这个进程已经不在了（它在停服期间跑完的，拿不到退出码）";
  if (state === "not-ours") {
    return `server 重启后这个号已经是另一个进程了（原命令在停服期间结束，拿不到退出码）${owing}`;
  }
  if (state === "suspected") {
    return "server 重启后这个号已经不在了，但进程表里还看得见这次创建的资源记号"
      + `（这台机器只拿得到无边界的 ps 展示文本，证不出它在哪个进程里，所以不敢下刀）${owing}`;
  }
  return `server 重启后它的组长已经退出、组里还有后代（拿不到退出码）${owing}`;
}
