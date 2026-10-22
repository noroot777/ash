// 哨兵创建**没走完**时的那一套:意图行的结局、进程的收口、以及对外那句话。
//
// 从 monitor-create.ts 拆出来,为什么单独成文:创建协议的正路(数一数、插一行、起进程、
// 上膛、放行)只有一条,而「没走完」这一面是三条不变量压出来的一整套判据 ——
//
//  · 起了进程 ⇒ 这段生命周期**只有一个出口**(第 9 轮审查 F2):所以收尾只许有一处
//    (`abortRegistration`),不是在每个新发现的 await 前面补一次;
//  · 那一行此刻**归谁**决定碰不碰它(用户点出来的「已停止」一个字都不许动);
//  · 收不干净的时候**不许冒充收干净**(四档措辞分开,只有真证明过的那档说「已回收」)。
//
// 正路那些不变量的来由写在 monitor-create.ts 文件头,别在这里重复一份。
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { monitors } from "./db/schema.js";
import type { StartMonitorResult } from "./monitor-create.js";
import { reclaimMonitorProcess, settleReclaim, type ReclaimVerdict } from "./monitor-reclaim-debts.js";
import { clearSpawnIdentity, type SpawnedMonitor } from "./monitor-spawn.js";
import { publish, type Row } from "./monitors.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

const detail = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 那条命令**从未开工**,所以这条意图行也不该留下来:删掉它,面板上就跟没点过一样。
 *
 * **只删还在 running 的那一行**(第 9 轮审查 F1/F2 的同一条判据):创建期被用户点停时,
 * `stopMonitor` 已经把「我停过」写在这一行上(status=stopped),无条件删掉就等于把那件事从
 * 界面上抹掉 —— 根 AGENTS.md:停止必须留下持久可见的状态。
 *
 * 删不掉也不致命 —— 它的 pid 是空的,接回那一侧按身份边条/「没能记下 pid」单独收口。
 */
async function deleteIntent(monitorId: string): Promise<void> {
  await db.delete(monitors)
    .where(and(eq(monitors.id, monitorId), eq(monitors.status, "running")));
}



/**
 * 创建没走完时**那一行的结局**:要么删掉(进程确认收干净了,界面上跟没点过一样),要么写成
 * `lost` 并照实说是哪一档。两笔都带 `status='running'` 条件 —— 所以它**幂等**,也因此可以重试。
 */
type IntentSettlement = { kind: "drop" } | { kind: "lost"; reason: string };

async function settleIntentRow(row: Row, settle: IntentSettlement): Promise<void> {
  if (settle.kind === "drop") {
    await deleteIntent(row.id);
    // 进程确认退了,身份边条这才真的没用了(欠着责任时它是补全身份的唯一线索,见
    // monitors.ts 的 `finish`;第 10 轮审查 N1 说的是同一条判据)。
    clearSpawnIdentity(row.logPath);
    return;
  }
  await db.update(monitors)
    .set({ status: "lost", endedAt: now(), endedReason: settle.reason })
    .where(and(eq(monitors.id, row.id), eq(monitors.status, "running")));
}

// 落不下去时的重试间隔。跟回收那一侧(monitor-reclaim-debts.ts 的 `LADDER_MS`)同一个形状:
// unref 定时器,不吊住进程退出。
const INTENT_LADDER_MS = [1_000, 5_000, 20_000];

/**
 * **补偿自己失败时也得有个接管者**(第 10 轮审查 F3)。
 *
 * 收口那一笔写不进库(DB 一瞬不可用、磁盘满)时,库里留下的是一条 `running` 行:没有 tail、
 * 没有到期定时器、没有退出回调 —— 它不会产生任何结束事件,而上一版在这里只有一次裸写(更早
 * 一版甚至是一次裸读),抛出去就**既没人接管、也没人重试**,那行会一直挂到有人手动清。
 *
 * 所以排一个阶梯重试。它的**兜底不是这个定时器**(unref,活不过进程退出),而是开机接回
 * (`reattachMonitors`:pid 空着的 running 行按「没能记下 pid」收口)—— 阶梯只是让这件事不用
 * 等到下次重启。阶梯跑完还没成就把这件事**说清**,不假装收了。
 */
function scheduleIntentSettle(row: Row, settle: IntentSettlement, attempt = 0): void {
  const delay = INTENT_LADDER_MS[attempt];
  if (delay === undefined) {
    console.error(
      `[ash] 哨兵 ${row.id} 创建失败的收口始终落不进库，这一行会一直写着 running（pid=${row.pid}），`
      + "下一次开机接回会把它判掉",
    );
    return;
  }
  const timer = setTimeout(() => {
    void settleIntentRow(row, settle)
      .then(() => { publish(row.taskId); })
      .catch((e) => {
        console.error(`[ash] 哨兵 ${row.id} 创建失败的收口第 ${attempt + 1} 次还是落不进库:`, detail(e));
        scheduleIntentSettle(row, settle, attempt + 1);
      });
  }, delay);
  timer.unref?.();
}

/**
 * **收口的唯一入口**:落定这一行的结局,落不下去就排重试(`scheduleIntentSettle`)。
 *
 * 登记之后的**每一条**失败出口都走它 —— 包括起进程失败那两条(spawn 同步抛、spawn 返回
 * error)。那两条上一版走的是「捕获异常、只记一行日志」的旧函数:一次 SQLite 抖动就留下
 * 一条永久 `running` 的登记行,没有 tail、没有到期定时器、没有退出回调,到期也不会有结果,
 * 攒满四条就再也创建不了哨兵 —— 而要恢复只能重启服务(第 11 轮审查 F3 实测
 * `afterDeadline=[{status:"running",pid:null}]`)。「拿到句柄之后才有人重试」不是个合理的
 * 边界:那一行是在**起进程之前**就插进去的。
 */
export async function settleIntent(row: Row, settle: IntentSettlement): Promise<void> {
  try {
    await settleIntentRow(row, settle);
  } catch (e) {
    console.error(`[ash] 哨兵 ${row.id} 的创建失败状态没能落进库,已排重试:`, detail(e));
    scheduleIntentSettle(row, settle);
  }
}

/** 创建期能动手的那一面句柄:**所有权由它本身证明**,不经过 pid 身份判定(见文件头)。 */
type SpawnHandle = Pick<SpawnedMonitor, "abandon" | "kill" | "waitExit" | "commandMayHaveStarted">;

/** 拿句柄收掉它、并**等一个真的退出事件**。拿不到就落回 pid 那条回收圈。 */
async function releaseProcess(row: Row, reason: string, handle?: SpawnHandle): Promise<ReclaimVerdict> {
  if (handle) {
    // ① 关闸:POSIX 上壳读到 EOF,在 exec 用户命令之前自己退掉;
    // ② 补一刀:win32 没有闸(命令可能已经在跑),POSIX 上也顺手把壳收干净;
    // ③ **等 `exit` 事件** —— 这是最硬的一份退出证明:不查 ps、不比 pid,它是我们自己起的
    //    那个 ChildProcess 的结局本身。于是「ps 不可用」或「身份没记全」都不妨碍这一档。
    handle.abandon();
    handle.kill();
    // **根退了不等于整项资源退了**(第 11 轮审查 F1-B)。`waitExit` 证明的是这个 ChildProcess
    // (壳的根)走了;命令一旦开工过,它派生的后台进程不随根退出而消失 —— win32 没有闸,
    // ③ 之前就可能开工,而那一侧 `taskkill /T` 也只在根还活着时走得通那棵树。
    //
    // 所以只有「命令从未开工」这一档敢当场说「收干净了」:那时壳底下什么都没有,根的 exit
    // 就是全部 —— **这是整个系统里唯一真的证明过整项不存在的一档**(`reclaimed`,见
    // `ReclaimVerdict`)。开过工的一律落到下面的回收圈,它最多到 `closed`(能追的线索追空),
    // 两者的措辞必须分开(第 13 轮审查 F1-B)。回收圈按**当前归属证据**判(整棵树带着的那条
    // 资源记号,见 proc.ts 的 `processUnitEvidence`),证得出就收掉,证不出就留责任。
    if (await handle.waitExit(2_000) && !handle.commandMayHaveStarted()) return "reclaimed";
  }
  // 句柄没等到(或压根没有句柄:启动恢复那一侧)⇒ 照旧走完整的回收圈:落责任 → 发信号 →
  // 追到线索空 → 收档。身份不全时那一圈不会下刀(proc.ts 的 `unverifiable`),但责任一定留下来。
  return await settleReclaim(await reclaimMonitorProcess(row, reason));
}

/**
 * **创建没走完时的唯一收尾**(第 9 轮审查 F2:起了进程 ⇒ 这段生命周期只有一个出口)。
 *
 * 做三件事,顺序固定:
 *  ① 收进程 —— 关闸、拿句柄杀、拿句柄等退出,确认不了才落回收责任(`releaseProcess`);
 *  ② 收那一行 —— **按它此刻归谁**判,不按失败原因判:
 *     · 它已经不是 `running` ⇒ 上面写的是**别人**落下的事实(用户点出来的「已停止」、删除
 *       流程的中间态)。一个字都不碰 —— 改掉或删掉就等于把「我停过」从界面上抹掉
 *       (根 AGENTS.md:停止必须留下持久可见的状态);
 *     · 它还是 `running` ⇒ 这是我们自己的意图行,而且**再也不会有人来接管它**(没放行 ⇒ 没
 *       attach ⇒ 没到期定时器 ⇒ 不会产生任何结束事件)。所以必须当场落定:确认收干净了就
 *       删掉(命令从未开工,界面上跟没点过一样),收不干净就写成 `lost` 并**照实说**是哪一档。
 *       上一版这一支是「一个字都不碰」,于是「来源那一轮已经过去」这类撤销会留下一条永远
 *       running、永远没人管的行 —— 跟 F2 要消掉的那一幕一模一样;
 *  ③ 说那句话 —— 四档分开(`reclaimed` / `closed` / `owed` / `unaccounted`),**只有真的证明过
 *    的那一档才许说「已回收」**(第 9 轮审查 N2 + 第 13 轮审查 F1-B:线索追空 ≠ 证明退出)。
 */
export async function abortRegistration(
  row: Row,
  kind: "failed" | "canceled",
  why: string,
  opts: { handle?: SpawnHandle; announced?: boolean } = {},
): Promise<StartMonitorResult> {
  // **收进程这一步自己也会抛**(回收圈里每一笔读写都可能):抛出去的后果跟它失败的后果不一样
  // —— 失败只是「没确认退出」,抛出去则连下面的收口一起跳过,于是留下一条没人管的 running 行。
  // 所以这里按「最坏那一档」兜住(第 10 轮审查 F3 的同类项),绝不让它带走整个收尾。
  let verdict: ReclaimVerdict = "unaccounted";
  try {
    verdict = await releaseProcess(
      row,
      kind === "failed" ? "哨兵的 pid 没能记下来，进程一并收回" : `${why}（放行前撤销，命令未开工）`,
      opts.handle,
    );
  } catch (e) {
    console.error(`[ash] 哨兵创建没走完,收进程这一步自己抛了 monitor=${row.id} pid=${row.pid}:`, detail(e));
  }
  if (verdict === "owed" || verdict === "unaccounted") {
    console.error(
      `[ash] 哨兵创建没走完,进程未确认退出 monitor=${row.id} pid=${row.pid}（${verdict}）：${why}`,
    );
  }
  const note = verdict === "closed"
    ? "能追的线索都追空了（整项退出本平台证不出，责任行留了档）"
    : verdict === "owed"
      ? "进程还没确认退出，回收责任已记下（开机会再收一次）"
      : "进程还没确认退出，而回收责任也没能落库（见 server 日志里的 pid，仍在重试落盘）";
  // 「这一行归别人」只有一种判据:它已经不是 running —— 而那条判据**写在收口那两笔的 WHERE 里**
  // (`settleIntentRow`),不再先 `select` 一次自己判。两个原因:
  //  · 那一次裸读抛出去的话,整个收口连带被跳过,留下一条 running、无人接管、也没有重试者的行
  //    (第 10 轮审查 F3 实测 `stored.status=running` + `commandStarted=false` + `pending=[]`);
  //  · 读完再判中间还有一道缝,用户正在这一刻点停时,判据按 SQL 走才是原子的。
  // 改到 0 行 = 这一行已经归别人(用户点出来的「已停止」、删除流程的中间态),正是我们该什么都
  // 不碰的那一档;改到 1 行 = 它是我们自己那条意图行,而且再也不会有人来接管它(没放行 ⇒ 没
  // attach ⇒ 没到期定时器),所以必须当场落定。
  // `drop` 只给**真的证明过**的那一档(命令从未开工):界面上跟没点过一样。线索追空
  // (`closed`)的那一档命令开过工 —— 照实写成 `lost` 并说明追到哪里。
  const settle: IntentSettlement = verdict === "reclaimed"
    ? { kind: "drop" }
    // 行上那句话要说清**是哪一种没走完**:自己的失败(pid 没记下来)跟被撤销读起来不一样。
    : {
      kind: "lost",
      reason: kind === "failed" ? `没能记下它的 pid：${why}。${note}` : `创建没走完：${why}。${note}`,
    };
  await settleIntent(row, settle);
  publish(row.taskId);
  // 时间线上先写过一句「哨兵已起」时必须留一句更正 —— 不然看时间线的人只会看到「起了」,
  // 而那条命令其实一个字都没跑。
  if (opts.announced) {
    await appendTaskTimeline(row.taskId, `哨兵没能开工：${row.description}。${why}`)
      .catch(() => { /* 更正写不进去也不该把收尾带下去 */ });
  }
  const tail = verdict === "reclaimed"
    ? (kind === "failed" ? "，已回收它的进程" : "，那条命令没有开工")
    // **撤销那一支不许顺口说「命令没有开工」**:走到这里就说明「它从未开工」没能证明
    // (句柄没等到退出,或者命令已经开过工),照实说成「证不出」—— 第 13 轮审查 F1-B。
    : (kind === "failed" ? `，${note}` : `，命令开没开工证不出；${note}`);
  return {
    ok: false,
    status: 409,
    error: kind === "failed" ? `哨兵登记失败${tail}：${why}` : `${why}${tail}`,
  };
}

/**
 * **pid 没能记下来 / 身份问不全 / 交接途中抛了**:收掉这个进程,然后照实说。
 *
 * 单独导出是为了让它能被直接钉住 —— 它要判的那件事正是前几轮审查反复指的那一条:
 * **收不干净的时候不许冒充收干净**(没有句柄时走的就是 pid 那条完整回收圈)。
 */
export const abandonRegistration = (
  row: Row, cause: string, handle?: SpawnHandle, announced?: boolean,
): Promise<StartMonitorResult> => abortRegistration(row, "failed", cause, { handle, announced });
