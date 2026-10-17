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
//     所以 pending 这一档挂一条**有界的恢复梯子**(`schedulePendingAdopt`),故障过去就自己
//     认回来、接上日志和期限;梯子用尽仍认不回来时把话写回卡片,等下一次启动/点停/删除。
import { and, eq } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { monitors, tasks } from "./db/schema.js";
import { adoptSpawnIdentity, notePendingIntent, type AdoptOutcome } from "./monitor-adopt.js";
import { reclaimMonitorProcess, settleReclaim, type ReclaimVerdict } from "./monitor-reclaim-debts.js";
import { reclaimState, type ReclaimState } from "./monitor-reclaim-evidence.js";
import { monitorWakeGate } from "./monitor-session.js";
import { clearSpawnIdentity } from "./monitor-spawn.js";
import { attach, finish, finishOffline, isAshKind, type Row } from "./monitors.js";
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
export async function reattachMonitors(): Promise<{ attached: number; lost: number; pending: number }> {
  // 只认 ash 自己起的：claude 的投影行没有 pid，拿去问身份必然认不出来，会被
  // 整批误判成 lost——而它们此刻多半还在 agent 那边好好跑着。它们的真实归宿由
  // `loseClaudeMonitorsOfSession` 在 agent 进程真的结束时统一收口。
  const rows = await db.select().from(monitors).where(and(eq(monitors.status, "running"), isAshKind));
  let attached = 0;
  let lost = 0;
  let pending = 0;
  for (const stored of rows) {
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
      // 挂一条有界的恢复梯子,见 `schedulePendingAdopt`。
      if (!adopted.identity && !adopted.settled) {
        await notePendingIntent(row, adopted.why);
        schedulePendingAdopt(row.id);
        pending += 1;
        continue;
      }
      if (!adopted.identity) {
        await writeOffIntent(row, adopted);
        lost += 1;
        continue;
      }
      // 认回来了:下面按正常身份走(接回 / 收尾 / 记责任),不再有特殊分支。
      row = { ...row, pid: adopted.identity.pid, pidStartedAt: adopted.identity.pidStartedAt };
    }
    const verdict = await takeOver(row);
    if (verdict === "attached") attached += 1;
    else if (verdict === "lost") lost += 1;
  }
  return { attached, lost, pending };
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
 * 重问身份的间隔。**有界**:故障多半是一瞬间的(一句 SELECT 失败、ps 这一刻不可用),所以前
 * 几档贴得很近;一直问不出来时拉开,最后一档之后就不再自己问 —— 把话写回卡片,等下一次启动、
 * 点停或删除(那几条路都会重新问一遍,见 monitor-reclaim 的枚举)。
 *
 * 跟回收那一侧的梯子(monitor-reclaim-debts 的 `LADDER_MS`)同一个形状:`unref` 定时器,不吊住
 * 进程退出。
 */
const PENDING_LADDER_MS = [1_000, 5_000, 20_000, 60_000, 180_000];
const ladders = new Map<string, NodeJS.Timeout>();

/** 撤掉所有恢复梯子(测试台子和 `detachAllMonitors` 用:库要关了,别让它醒过来问一个关了的库)。 */
export function stopPendingAdopts(): void {
  for (const [, timer] of ladders) clearTimeout(timer);
  ladders.clear();
}

/**
 * 给一条「这一刻认不回来」的创建意图挂上恢复接管者(第 20 轮审查 F2)。
 *
 * 它负责的是**这一次启动周期内**的那件事:故障过去就自己把身份认回来、接上 tail 和期限;
 * 认定壳已经不在就照实写掉;**到了约定期限仍然认不回来就按到期收尾** —— 到期这件事不该等
 * 认领(日志里的输出照旧补读、补推,见 `finishOffline`),否则界面会一直停在「在等」。
 *
 * **一个信号都不因此多发**:认领的判据一个字没松(`adoptSpawnIdentity` / `reclaimEvidence`),
 * 梯子只是把「再问一遍」这件事自动化。
 */
export function schedulePendingAdopt(monitorId: string, step = 0): void {
  const existing = ladders.get(monitorId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    ladders.delete(monitorId);
    void retryPendingAdopt(monitorId, step).catch((e) => {
      console.error(`[ash] 待认领哨兵重问身份时自己出错 monitor=${monitorId}:`, e);
    });
  }, PENDING_LADDER_MS[Math.min(step, PENDING_LADDER_MS.length - 1)]);
  (timer as { unref?: () => void }).unref?.();
  ladders.set(monitorId, timer);
}

async function retryPendingAdopt(monitorId: string, step: number): Promise<void> {
  if (dbClient.closed) return;
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
  // 别人已经处理过了(认回来了 / 被点停 / 被删掉)⇒ 梯子到此为止,不抢。
  if (!row || row.status !== "running" || row.pid !== null) return;
  const adopted = await adoptSpawnIdentity(row);
  if (adopted.identity) {
    await takeOver({ ...row, pid: adopted.identity.pid, pidStartedAt: adopted.identity.pidStartedAt });
    return;
  }
  if (adopted.settled) {
    await writeOffIntent(row, adopted);
    return;
  }
  // 还是认不回来。**期限照常到**:到点就按到期收尾(输出补读补推、责任按档位留),否则这一行
  // 会一直挂在「在等」上 —— 那正是审查实测到的现场。
  if (new Date(row.expiresAt).getTime() <= Date.now()) {
    await expirePendingIntent(row, adopted);
    return;
  }
  if (step + 1 >= PENDING_LADDER_MS.length) {
    await notePendingIntent(row, adopted.why, { exhausted: true });
    return;
  }
  await notePendingIntent(row, adopted.why);
  schedulePendingAdopt(monitorId, step + 1);
}

/**
 * 到期了、而这一刻仍然认不回它的进程。
 *
 * 两件事都要做,而且顺序不能反:**先按档位把责任留下**(有候选号就记在它身上 —— 它拿不到
 * 启动时刻,所以落在 `unverifiable` 档:记责任、不下刀;连候选号都没有时 `reclaimMonitorProcess`
 * 自己返回 `unaccounted`,行留着),**再**写终态 —— 反过来就成了「卡片说已到期、责任没人认」。
 */
async function expirePendingIntent(row: Row, adopted: AdoptRefused): Promise<void> {
  const outcome = await reclaimMonitorProcess(
    adopted.candidate ? { ...row, pid: adopted.candidate.pid, pidStartedAt: null } : row,
    "盯满了约定的时长，而这一刻认不回它的身份",
  );
  const verdict = await settleReclaim(outcome, 0);
  if (verdict === "unaccounted") {
    console.error(`[ash] 待认领哨兵到期:既认不回身份、责任也没落库 monitor=${row.id}`);
  }
  await finishOffline(row, "expired", `盯满了约定的时长（server 重启后这一刻认不回它的进程${adopted.why}，`
    + `所以一个信号都没发${verdict === "owed" ? "，已记下回收责任" : verdict === "unaccounted" ? "，而回收责任尚未保存（见 server 日志）" : ""}；`
    + `日志里已经产出的那几行照常补读补推）`);
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

