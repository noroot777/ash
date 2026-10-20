// 哨兵的**创建协议**:起一条哨兵这件事本身。运行时(盯、推、停、接回)在 monitors.ts,
// 进程与放行闸在 monitor-spawn.ts,来源归属在 monitor-session.ts。
//
// ── 不变量:**命令开工 ⇒ 身份已经可恢复** ───────────────────────────────────────
//
// 等价说法:身份没落库 ⇒ 那条命令一个字都没跑过。它不是讲究,是第 7 轮审查 F3 实测的那一幕
// 的根:原来的顺序是「先 spawn,再 insert」——
//   1. 命令已经独立跑起来了,ash 才去登记;
//   2. 登记失败时只能**事后**追它(落责任 → 发信号 → 追到线索空 → 收档);
//   3. 而当身份查询那一刻也不可用、责任表又写不进去时(两张表都被注入写失败),那个进程的
//      唯一线索只剩 `scheduleReclaimPersist` 的内存参数 —— unref 定时器,活不过服务退出;
//   4. 重启恢复只枚举 monitors 和债表,两张表都没有它:命令还在后台跑着,谁都再也找不到它。
// 「以后定时再保存」不构成资源交接,所以这一层不靠它,而是**换顺序**:
//
//   ① 先落身份行(pid 还空着 = 创建意图)。落不下去 ⇒ 什么都没起,干净地 409。
//   ② 起进程 —— 它停在放行闸前面,还没 exec 用户的命令(POSIX,见 monitor-spawn.ts)。
//   ③ 把 pid 补上。补不上 ⇒ **不放行**,命令从未开工;照旧补一刀 + 走回收圈兜底。
//   ④ 挂上运行时(tail、到期定时器、退出回调)—— 这时它还停在闸前面,必然还活着。
//   ⑤ 放行。命令从这一刻才开工,而它的身份早在 ① 就落库了。
//
// 残余窗口只有一处,**在 win32**:那一侧没有放行闸(`cmd.exe` 里没有可靠的「从第 3 号句柄读
// 一行」写法),所以 ③ 之前命令可能已经在跑。**但它不再是「找不回来」**:`spawn` 一返回就把
// `{pid, 这一刻}` 同步写进日志旁边的身份边条(monitor-spawn.ts),重启那一侧拿它按代次认回来
// (`processStartedNear`,见 monitors.ts 的 `reattachMonitors`)。剩下的差别只有「闸」本身:
// win32 上命令可能在身份落库之前就开工,**这条差别未在 Windows 真机验证**(约定见根 AGENTS.md)。
//
// 而那个边条自己也会写不下来(盘满、目录权限)。两样都没有时,那条命令可能已经开工而**重启后
// 谁都再也定位不到它** —— 这正是 ① 换顺序要消掉的那一幕,只是从「库」挪到了「闸与边条」。所以
// 交接可不可恢复由 spawn 层显式答(`handoverRecoverable`),答不出是就**拒这次创建**:就地拿
// 句柄收掉它、照实说。POSIX 恒有闸,所以这一档只可能在 win32 出现(第 10 轮审查 F2-C)。
//
// ── 不变量:**起了进程 ⇒ 这段生命周期只有一个出口**(第 9 轮审查 F2)─────────────────
//
// ②(spawn 成功)到 ⑥(运行时接管完成)之间的每一个 await 都可能抛,而抛出去的那一刻:进程
// 已经存在、库里那行写着 running、却没有 tail、没有到期定时器、没有退出回调 —— 它不会到期
// 收尾,也不会产生任何结束事件,除了重启或人工再也没有人碰它(第 9 轮审查 F2 实测:只让回填
// pid 之后的第一次读库抛一次,`stored.status=running` + `shellAliveAfterDeadline=true`)。
// 「在新发现的那个 await 前面再补一次读」治不了这个 —— 下一次新增的 await 又会漏在外面。
// 所以这一段整体包在**一个所有权边界**里:任何异常、任何提前返回,都走同一个收尾
// (`abortRegistration` 一处)—— 关闸、拿句柄杀、拿句柄确认退出,确认不了
// 才落回收责任。
//
// ── 不变量:**身份不全不许开工**(第 9 轮审查 F3)─────────────────────────────────
//
// 「可恢复」指的是**跨代可恢复**:光有 pid 不够,pid 会被复用,所以回收那一侧必须能证明
// 「这个号上现在还是当初那一个」。启动时刻问不出来时(ps 抽一下)原来照旧回填、照旧放行,
// 于是留下一行 `pid_started_at` 为空的身份 —— 回收判据在那一档上退化成存在性检查,原命令
// 跑完、号被复用之后,接回/清扫/重复停止三条路都会拿着别人的进程当我们的下刀
// (判据已收紧在 proc.ts 的 `unverifiable` 档)。所以这里**拒绝**:身份问不全就不放行,
// 而那一刻要收掉的进程由**句柄**证明所有权,不经过 pid 身份那条路。
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { MONITOR_MAX_PER_TASK, normalizeMonitorTimeout, type TaskMonitor } from "@ash/shared/monitor";
import { db } from "./db/index.js";
import { monitors, projects, sessions, tasks } from "./db/schema.js";
import { isTaskRevoked } from "./claude-monitor-revoked.js";
import { reclaimMonitorProcess, settleReclaim, type ReclaimVerdict } from "./monitor-reclaim-debts.js";
import {
  CALLER_EXPIRED, isReviewSourceActive, monitorSourceGate, REVIEW_SOURCE_GONE,
  type MonitorCaller,
} from "./monitor-session.js";
import { clearSpawnIdentity, monitorLogPath, spawnMonitor, type SpawnedMonitor } from "./monitor-spawn.js";
import {
  attach, liveMonitorsOf, publish, serialize, toTaskMonitor, type Row,
} from "./monitors.js";
import { inspectProcess } from "./proc.js";
import { holdCompletionForNewMonitor, terminalLandingInFlight } from "./task-complete.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { id, now } from "./util.js";

export type StartMonitorInput = {
  taskId: string;
  command: string;
  description?: string;
  cwd?: string | null;
  timeoutMs?: number;
  ownerUserId?: string | null;
  /**
   * **这次创建是谁发起的**,由入口核验后交上来(见 `monitor-session.ts` 的 `MonitorCaller`)。
   * 必填:哨兵唯一的出口是「唤醒这个任务」,而唤醒哪条会话由来源决定 —— 让它可缺省就等于
   * 默许「不知道就按执行者算」,那正是第 7 轮审查 F2 要消掉的那一种静默(审查者挂的哨兵
   * 把实现者叫起来烧一个回合,审查那条会话继续等不到人)。
   */
  caller: MonitorCaller;
};

export type StartMonitorResult =
  /** `notice` = 这次创建顺带改变了别的东西,调用方要原样带给 agent(目前只有一种:撤掉了它手里那份完成确认)。 */
  | { ok: true; monitor: TaskMonitor; notice?: string }
  /** `needsWakeTarget` = 拒绝的理由是「说不清醒来叫谁」:调用方指定一个唤醒目标就能再来。 */
  | { ok: false; status: 400 | 404 | 409; error: string; needsWakeTarget?: true };

/** 哨兵在哪儿跑：显式指定 > 任务最近一条会话的工作目录 > 项目仓库目录。 */
async function resolveCwd(taskId: string, explicit?: string | null): Promise<string | null> {
  if (explicit?.trim()) return explicit.trim();
  const session = (await db
    .select({ cwd: sessions.cwd })
    .from(sessions)
    .where(eq(sessions.taskId, taskId))
    .orderBy(desc(sessions.startedAt))).find((s) => s.cwd);
  if (session?.cwd) return session.cwd;
  const task = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task?.projectId) return null;
  const project = (await db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, task.projectId))).at(0);
  return project?.repoPath ?? null;
}

const text = (value: unknown): string | null => (typeof value === "string" ? value.trim() : null);
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
async function settleIntent(row: Row, settle: IntentSettlement): Promise<void> {
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
async function abortRegistration(
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

/**
 * pid 的**完整身份**:号 + 这一代的启动时刻。
 *
 * 查不出来时重试两次 —— ps(或 Windows 上那段 PowerShell)不可用通常只是一瞬。仍然查不出来
 * 就返回 null,调用方据此**拒绝这次创建**:带着一个只能证明存在的残缺身份放行,等于把
 * 「看见一个进程活着」当成「已证明有权回收它」(第 9 轮审查 F3,判据见 proc.ts 的
 * `unverifiable`)。
 */
async function completeIdentity(pid: number): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const startedAt = inspectProcess(pid)?.startedAt ?? null;
    if (startedAt) return startedAt;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 60));
  }
  return null;
}

/**
 * **上膛**:把完整身份写进那一行,并在**同一条语句**里证明这次创建此刻仍然该放行。
 *
 * 一条 `UPDATE … WHERE` 同时断言四件事(第 9 轮审查 F1 要的「CAS 或等价协议」):
 *  · 这一行还在、还是 running —— 没有被用户点停(`stopMonitor` 的第 ① 段先落「我停过」);
 *  · pid 还空着 —— 这一行还没被别人上过膛;
 *  · 发请求的那一轮**还是当前这一轮**(`tasks.active_turn_token` 没换);
 *  · 绑下来的那一次审查**还在那一轮上**(没收尾、没进下一轮)。
 *
 * 为什么必须是一条语句:这几样分别读一遍再判,读与判之间依旧可以换轮,而「在新发现的 await
 * 前面再补一次读」是个没有尽头的打法(审查原话)。回合轮换(orchestrator)与审查推轮
 * (free-review-round)都不排哨兵这条 `task:<id>` 队列,所以唯一可靠的交汇点是数据库自己。
 *
 * 改到 0 行 ⇒ 不放行。原因由 `diagnoseArm` 事后查出来,只用于**措辞**:它答错了也不会让一条
 * 不该开工的命令开工。
 */
async function armRow(row: Row, startedAt: string, token: string | null): Promise<boolean> {
  const result = await db.update(monitors)
    .set({ pid: row.pid, pidStartedAt: startedAt })
    .where(and(
      eq(monitors.id, row.id),
      eq(monitors.status, "running"),
      isNull(monitors.pid),
      ...(token === null ? [] : [sql`(select active_turn_token from tasks where id = monitors.task_id) = ${token}`]),
      sql`(monitors.source_review_run is null or exists (
            select 1 from free_review_runs r
            where r.id = monitors.source_review_run
              and r.status = 'reviewing'
              and (monitors.source_review_round is null or r.current_round = monitors.source_review_round)))`,
    ));
  return Number((result as { rowsAffected?: number | bigint } | null)?.rowsAffected ?? 0) > 0;
}

/**
 * **没上膛成,但 pid 还是要落到那一行上** —— 它是那个壳的唯一线索。
 *
 * 跟上膛分得很开,两件事判据不同:上膛决定**放不放行**(所以它必须是条件的、原子的);这一笔
 * 只决定**身份留不留**。混成一笔的代价在第 8 轮审查 ⑥ 已经钉过:删除那一侧按资源责任核对,
 * 而它枚举的是 `pid is not null` 的行(monitor-reclaim.ts)—— pid 空着的行会被当成「没东西
 * 要收」,于是用户点停留下的那条记录再也指不到那个进程。
 *
 * 条件只有 `pid is null`:上过膛的行不会走到这里,也绝不许被这一笔改写。`startedAt` 传 null =
 * 身份只有号没有代次,**照实留空**:伪造一个进去就等于把「无从比对」写成「已验证」。
 */
async function noteProcessClue(row: Row, startedAt: string | null): Promise<void> {
  try {
    await db.update(monitors)
      .set({ pid: row.pid, pidStartedAt: startedAt })
      .where(and(eq(monitors.id, row.id), isNull(monitors.pid)));
  } catch (e) {
    console.error(`[ash] 哨兵 ${row.id} 的 pid 线索写不进库（pid=${row.pid}）:`, detail(e));
  }
}

/** 上膛没改到行 —— 到底是哪一种。**只决定说哪句话**(见 `armRow`)。 */
async function diagnoseArm(monitorId: string, taskId: string, token: string | null): Promise<string> {
  const fresh = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
  if (!fresh) return "创建还没完成，这条哨兵的记录已经没了";
  if (isTaskRevoked(taskId)) return "创建还没完成，这个任务已经开始删除";
  if (fresh.status !== "running") {
    return `创建还没完成，这条哨兵已经被停掉了（${fresh.endedReason ?? "已停止"}）`;
  }
  if (token !== null) {
    const task = (await db.select({ token: tasks.activeTurnToken }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (task?.token !== token) return CALLER_EXPIRED;
  }
  if (fresh.sourceReviewRun
    && !await isReviewSourceActive(fresh.sourceReviewRun, fresh.sourceReviewRound)) {
    return REVIEW_SOURCE_GONE;
  }
  return "创建还没完成，这条登记行被别的写入改过了（没有放行，那条命令没有开工）";
}

/**
 * 起一个哨兵。
 *
 * **整段按任务串行**：「数一数在跑几个」和「插进去一条」之间隔着好几个 await，并发打进来时
 * 每一个都在别人落库之前数完了数，于是六个请求能一起过 4 个的闸、真的起六个长跑进程（第 1
 * 轮审查实测 successfulStarts=6）。既有的 `serialize` 按 monitorId 排队，护不到「还没有
 * id」的创建期，所以这里按 `task:<id>` 另排一条队。
 */
export async function startMonitor(input: StartMonitorInput): Promise<StartMonitorResult> {
  // 参数一律在**起进程之前**校验并规范化。顺序反过来的话，一个 description: 7 就能让
  // trim 抛在 spawn 之后：进程已经脱离 ash 跑起来了，记录却没落，于是它既不在列表里、
  // 也没有到期定时器，谁都停不掉（第 1 轮审查复现：HTTP 500 + 一个无主的 shell 还活着）。
  const command = text(input.command);
  if (!command) return { ok: false, status: 400, error: "command 不能为空" };
  if (input.description !== undefined && input.description !== null && text(input.description) === null)
    return { ok: false, status: 400, error: "description 必须是字符串" };
  if (input.cwd !== undefined && input.cwd !== null && text(input.cwd) === null)
    return { ok: false, status: 400, error: "cwd 必须是字符串" };
  const description = text(input.description) || command;

  return serialize(`task:${input.taskId}`, async () => {
    const task = (await db.select().from(tasks).where(eq(tasks.id, input.taskId))).at(0);
    if (!task) return { ok: false, status: 404, error: "任务不存在" };
    // 入口与出口同一份判据（创建问 `monitorSourceGate`、出口问 `monitorWakeGate`，两者
    // 共用 shared 的 `monitorBlockedReason`）。只判归档、不判终态的话，已完成的任务上照样
    // 起得来一个真进程，而 `pushToTask` 会把它推的每一条都按终态拒掉——命令在后台烧着，
    // 任务永远不醒（第 2 轮审查实测）。
    // 那一份判据里还含着「审查还在进行」这条豁免：审查跑在已经 done 的任务上，不豁免的话
    // 审查者一个哨兵都挂不上。它同时回答「是谁挂的、属于哪次审查」——按**入口核验过的调用
    // 来源**判，不是按「此刻哪个 agent 进程还活着」猜（见 monitor-session.ts 文件头）。
    const source = await monitorSourceGate(task, input.caller);
    if (source.blocked) {
      return { ok: false, status: 409, error: source.blocked, ...(source.needsWake ? { needsWakeTarget: true as const } : {}) };
    }
    // ⑤-b **这个任务此刻正在落一个会收走哨兵的终态** —— 一个字都不许起。
    //
    // 上面那道 `monitorSourceGate` 读的是**库里的状态**，而终态行是在它落库之前就已经决定好
    // 了的：结算先核一遍阻塞物（放行）、随后才写 `done` 那一行。两件事之间的那条缝里，这里
    // 读到的仍是 `running`，于是创建照旧放行 —— 紧接着的终态清理把它当场停掉（第 2 轮审查
    // R2-1 实测 `OLD_F1_FINAL_SETTLEMENT_RACE`：`startMonitor:true` → `monitorAfter:"stopped"`）。
    //
    // 结算那一关**在同一把 `task:<id>` 锁里**置的这个闩（见 task-complete.ts 的
    // `beginTerminalLanding`），所以这里是一句同步判断就能答的事实，不是又一次「读库猜」。
    if (terminalLandingInFlight(input.taskId)) {
      return {
        ok: false,
        status: 409,
        error: "这个任务正在落终态（本回合已经在结算了），这一刻挂不上哨兵 —— 挂上去也会被终态清理"
          + "当场停掉。命令一个字都没跑；要盯的事情还在的话，等这一轮结算完、任务被重新唤醒后再挂。",
      };
    }

    const live = await liveMonitorsOf(input.taskId);
    if (live.length >= MONITOR_MAX_PER_TASK)
      return { ok: false, status: 409, error: `这个任务已经有 ${live.length} 个哨兵在盯了（上限 ${MONITOR_MAX_PER_TASK}），先停掉一个` };

    const cwd = await resolveCwd(input.taskId, input.cwd);
    if (!cwd) return { ok: false, status: 409, error: "定位不到工作目录，显式传 cwd" };

    const monitorId = id();
    const logPath = monitorLogPath(input.taskId, monitorId);
    // **这一次创建独有的资源记号**:它随环境种进那个壳,整棵树都带着它(见 platform.ts 的
    // `MONITOR_UNIT_ENV`)。生成在**插意图行之前**,所以它跟 pid 不一样 —— 从第一条语句起就
    // 已经落库、跨重启认得回来,而不是靠事后回填。归属与整项退出这两问都只认它
    // (第 12 轮审查 F1:命令原文不是凭证)。
    const unitToken = `${monitorId}.${id()}`;
    const timeoutMs = normalizeMonitorTimeout(input.timeoutMs);
    const startedAt = new Date();
    const intent: Row = {
      id: monitorId,
      taskId: input.taskId,
      command,
      description,
      cwd,
      status: "running",
      // **这两列先空着**：进程还没起，而身份行必须先落（见文件头的创建协议）。③ 回填。
      pid: null,
      pidStartedAt: null,
      unitToken,
      logPath,
      offset: 0,
      events: 0,
      exitCode: null,
      // **同一个瞬间**算两列：分别取 Date.now() 会差 1ms，而对外那个到期时刻是
      // `started_at + timeout_ms` 现算的（见 toTaskMonitor），差值会变成「库里写的」与
      // 「卡片显示的」不一致。
      startedAt: startedAt.toISOString(),
      expiresAt: new Date(startedAt.getTime() + timeoutMs).toISOString(),
      endedAt: null,
      endedReason: null,
      // 「谁让它停的」只在真被停下来时才有值（见 schema 的 ended_by）。
      endedBy: null,
      // 「它的结果我不要了」也只在有人真这么说过时才有值（见 schema 的 results_abandoned_at）。
      resultsAbandonedAt: null,
      resultsAbandonedReason: null,
      ownerUserId: input.ownerUserId ?? null,
      kind: "ash",
      nativeId: null,
      cliSessionId: null,
      // 只有 claude 投影才有「起它的那个 tool_use」。
      toolUseId: null,
      // 代次结论与起点下界都是 claude 投影那一侧的事：ash 自己 spawn 的进程有真 pid，
      // 起点就是 spawn 那一刻（见 schema-monitors.ts）。
      sourceRun: null,
      startLowAt: null,
      // **哨兵醒来时该叫哪条会话**：审查是旁路回合，跑在自己那条 reviewer 会话上。认不出
      // 来就留 NULL = 按老样子叫执行者（见 monitor-session.ts）。
      sourceRole: source.role,
      // **它的命跟着哪次审查走**：非空 = 任务终态连坐清理要放过它、事件出口按那次审查
      // 是否还在判、唤醒时按那次审查的执行器续跑（见 schema-monitors.ts）。
      sourceReviewRun: source.reviewRun,
      // **哪一轮**：`nextRound` 复用同一个 run.id（只是把 current_round 加一、状态推回
      // reviewing），所以只记 runId 的话，上一轮遗留的哨兵会被下一轮当成自己的输入重新
      // 解释（见 schema-monitors.ts）。
      sourceReviewRound: source.reviewRound,
      // ash 自己起的：期限是它自己定的，当然知道。
      sourceLifetime: "bounded",
      // ash 自己起的：期限是它自己定的，当然可信；进程就是下面 spawnMonitor 起的那个，
      // 代次由 pid/pidStartedAt 两列（上面）记着，不走 claude 投影那套来源代次。
      lifetimeEvidence: "self",
      sourcePid: null,
      sourcePidStartedAt: null,
      // ash 自己 spawn 的，起点就是这一刻，没有不确定性 —— 误差界 0。两列成对写：少了误差界
      // 这一行就「无法重验」，对外会丢掉期限（见 shared 的 monitorStartTrusted）。
      startEvidence: "observed",
      startAnchorWidthMs: 0,
      timeoutMs,
    };

    // ① 身份先落库。**这一步失败时什么都还没起**,所以没有任何要回收的东西 —— 不必落责任、
    //    也不许声称回收了什么。
    try {
      await db.insert(monitors).values(intent);
    } catch (e) {
      return { ok: false, status: 409, error: `哨兵登记失败，那条命令一个字都没开始跑：${detail(e)}` };
    }

    // ② 起进程。POSIX 上它停在放行闸前面，还没 exec 用户的命令。
    //
    // **同步抛出也要收尾**:这一层的契约是「要么给句柄、要么给一句话」(见 monitor-spawn.ts),
    // 但契约靠调用方兜住才算数 —— 漏在外面的话,一个 `mkdirSync` 失败就会带着整个
    // `startMonitor` 抛出去,留下一条 pid 永远空着的 running 行:没有 tail、没有到期定时器、
    // 还占着每个任务 4 个的名额(第 8 轮审查 F3 的同类项)。
    let spawned: ReturnType<typeof spawnMonitor>;
    try {
      spawned = spawnMonitor({ command, cwd, logPath, unitToken });
    } catch (e) {
      // 起不起来都一样要**落定**这一行:它是在起进程之前就插进去的,没人会来接管它
      // (没有 attach、没有到期定时器)。删不掉就排重试,不是记一行日志就算完(F3)。
      await settleIntent(intent, { kind: "drop" });
      return { ok: false, status: 409, error: `哨兵起不来，那条命令一个字都没开始跑：${detail(e)}` };
    }
    if ("error" in spawned) {
      await settleIntent(intent, { kind: "drop" });
      return { ok: false, status: 409, error: spawned.error };
    }

    // ── 所有权边界:从这里到 ⑥ 交接完成,**所有出口只有一个**(见文件头)──────────────
    //
    // 边界里的每一个 await 都可能抛,而抛出去的那一刻进程已经存在、行写着 running、运行时却
    // 还没接手:不会到期、不会收尾、不会有结束事件。所以这里不挨个列「哪几个函数会抛」,而是
    // 整段兜住 —— 以后在这一段里新增 await 不必再想一遍这件事。
    const row: Row = { ...intent, pid: spawned.pid };
    const token = input.caller.kind === "turn" ? input.caller.token : null;
    let handed = false;
    let announced = false;    // 时间线上那句「哨兵已起」写出去了吗(失败时要追一句更正)
    try {
      // ③-0 **交接要可恢复**。闸和身份边条两样都没有时(只可能是 win32 + 边条写失败),这条
      //      命令可能已经开工,而 ash 这一刻要是没了就再没有东西能定位它 —— 重启枚举的是
      //      monitors(pid 还空着)和边条(没写成),两边都指不到那个进程。带着这种交接放行等于
      //      把「以后谁都收不掉它」写进系统,所以拒(第 10 轮审查 F2-C;判据在 spawn 层的
      //      `handoverRecoverable`)。要收的那个进程由**句柄**证明所有权,不经过 pid 那条路。
      if (!spawned.recoverable) {
        // pid 照旧落到那一行上:它是此刻唯一的线索(启动时刻留空 = 如实记「无从比对」)。
        await noteProcessClue(row, null);
        return await abandonRegistration(
          row,
          "这次开工交接恢复不了（这一侧没有放行闸，身份边条也写不下来），ash 一重启就再也定位不到它，所以不放行",
          spawned,
        );
      }

      // ③ **身份要齐**。只有号没有代次 = 跨代认不回来,也就不许开工(见文件头第三条不变量)。
      const startedAt = await completeIdentity(spawned.pid);
      if (!startedAt) {
        // pid 仍然要落到那一行上:身份不全不等于没有线索(启动时刻留空 = 如实记「无从比对」)。
        await noteProcessClue(row, null);
        return await abandonRegistration(
          row,
          "问不出它的启动时刻（进程查询不可用），只有 pid 的身份没法跨代认回来，所以不放行",
          spawned,
        );
      }
      row.pidStartedAt = startedAt;

      // ④ 「已起」这一行排在 attach 之前:挂上运行时的那一刻结局可能**已经发生**(壳自己就退
      //    了,一次性结局缓冲会当场把它结算成 exited),那时再写「已起」就排在「结束」后面了。
      //    排在 ⑤ 上膛之前是另一条:上膛到放行之间**不许再有 await**(⑤ 的注释)。没上膛成的
      //    那一路由 `abortRegistration` 追一句「哨兵没能开工」更正。
      await appendTaskTimeline(row.taskId, `哨兵已起：${row.description}（${command}）`);
      announced = true;

      // ⑤ **上膛**:写进完整身份,同一条语句里证明「这次创建此刻仍然该放行」(见 `armRow`)。
      if (!await armRow(row, startedAt, token)) {
        const why = await diagnoseArm(monitorId, input.taskId, token);
        // 不放行,但**身份照旧落到那一行上**:它是那个壳的唯一线索(见 `noteProcessClue`)。
        await noteProcessClue(row, startedAt);
        return await abortRegistration(row, "canceled", why, { handle: spawned, announced: true });
      }
      // 删除不是一个瞬间,而 `beginTaskRevocation` 是**同步**关闸、之后才去抢这条队列 —— 所以
      // 放行前最后再问一次。这一问是纯内存的,**上膛和放行之间因此没有任何 await**。
      if (isTaskRevoked(input.taskId)) {
        return await abortRegistration(
          row, "canceled", "创建还没完成，这个任务已经开始删除", { handle: spawned, announced: true },
        );
      }

      // ⑥ **先挂运行时、再放行**。顺序反过来有个安静的洞:`echo x` 这种瞬间跑完的命令会在
      //    `attach` 之前就 exit。那个洞现在由 spawn 层的一次性结局缓冲兜住(晚订阅也收得到),
      //    但顺序照旧按「挂好再放行」排 —— 让「订阅不到」这件事连发生的机会都没有。
      attach(row, spawned.onExit);
      spawned.release();   // 命令从这一刻才真正开工,而它的身份在 ⑤ 已经完整落库
      handed = true;
      publish(row.taskId);
      // ⑦ **这一刻 agent 手里可能正握着一份完成确认**:它先 complete_task 再 start_monitor,
      //    那份确认已经不成立了 —— 不撤的话结算照旧落 done,刚起的这条当场被连坐停掉
      //    (第 1 轮审查 F1 实测 confirmationStillSet=true / monitorAfter=stopped)。撤它必须
      //    跟「数一数有几个哨兵」排同一条队,所以落在这个 `serialize` 里面;那一句话随创建
      //    结果回给 agent,它读结果的那一眼就看到落位变了。**绝不抛**(见那个函数)。
      const notice = await holdCompletionForNewMonitor(row.taskId, row.description);
      return { ok: true, monitor: toTaskMonitor(row), ...(notice ? { notice } : {}) };
    } catch (e) {
      // 交接已经完成 ⇒ 这个进程归运行时了,这里再去收它反而是抢它的东西:原样抛出去。
      if (handed) throw e;
      return await abandonRegistration(row, `这一次创建中途出错了：${detail(e)}`, spawned, announced);
    }
  });
}
