// 历史回填：把 agent 已经起过的内置 Monitor 补进投影表，并按来源事实纠正已有的记录。
//
// 为什么非有不可：这个功能的起点就是用户打开一个任务，agent 在对话里反复说「等 Monitor
// 通知」，而哨兵面板写着「这个任务上还没有哨兵」。实时投影只能管**之后**发生的事——对那个
// 触发需求的任务本身，以及所有升级前跑过的任务，面板仍然是空的。
//
// 文件枚举、增量读取和事件认人都在 `claude-monitor-scan.ts`；这个文件只管两件事：
//
// ① **提交扫出来的事实**（`commitFound`）。缺的插进去，已有的按事实优先级补齐/纠正。
// ② **重新裁决已有行的死活**（`reconcileLiveness`）。这一步**不依赖文件有没有新内容**——
//    进程可能刚刚死掉，或者上一次把还活着的来源误判成了 lost。上一版只在「历史里读到终态」
//    时才改状态，于是实测两个方向都卡住：旧 lost 行的来源还活着也不恢复、旧 running 行的
//    进程已经没了也不纠正（第 4 轮审查 existingLiveness）。
//
// ── 事实优先级（整条链共用一套）────────────────────────────────────────────────
//
//   来源说过的终态  >  ash 按来源死活的推断（running / lost）>  没有结局
//
// 「没读到某条事实」不等于「那条事实不成立」：没读到终态要先问来源还活不活，而不是直接判死。
// 来源已经说过的终态不被重放改写（否则显示跟着扫描次数变），ash 自己的推断必须对纠正开放
// （判据 `monitorStatusCorrectable`，与实时投影共用）。
import { and, eq, inArray } from "drizzle-orm";
import { monitorStatusCorrectable, type MonitorLifetime } from "@ash/shared/monitor";
import { bus } from "./bus.js";
import { createLivenessProbe } from "./claude-monitor-liveness.js";
import { foundOf, newTaskScan, scanSession, type Found, type TaskScan } from "./claude-monitor-scan.js";
import { db, dbClient } from "./db/index.js";
import { monitors, sessions } from "./db/schema.js";
import { id, now } from "./util.js";

/**
 * 每个任务的扫描快照。**不是「扫过就永不再扫」**——它记着每个文件读到第几字节，下次只读
 * 新增那一段（见 claude-monitor-scan.ts 的文件头）。
 */
const snapshots = new Map<string, TaskScan>();

/** 正在跑的那次 → 它的 Promise。并发调用共享同一次工作，不重复读盘。 */
const inflight = new Map<string, Promise<number>>();

/**
 * 把一个任务的内置 Monitor 补进投影表，并纠正已有记录。
 *
 * 返回新补了几行（纠正不计入）。并发调用共享同一次扫描。
 */
export function backfillClaudeMonitors(taskId: string): Promise<number> {
  if (dbClient.closed) return Promise.resolve(0);
  const running = inflight.get(taskId);
  if (running) return running;
  const job = runBackfill(taskId).finally(() => inflight.delete(taskId));
  inflight.set(taskId, job);
  return job;
}

async function runBackfill(taskId: string): Promise<number> {
  let added = 0;
  try {
    const rows = await db
      .select({ id: sessions.id, cliSessionId: sessions.cliSessionId, outPath: sessions.agentOutPath })
      .from(sessions)
      .where(and(eq(sessions.taskId, taskId), eq(sessions.agentType, "claude")));

    // 快照跨调用复用，但**会话清单每次重查**：任务后来新增了会话，上一次的快照里没有它
    // （实测 noSessionThenNewSession：首次回填时任务还没有会话，之后新增 → 永远读不到）。
    const scan = snapshots.get(taskId) ?? newTaskScan();
    snapshots.set(taskId, scan);
    scan.truncated = false;
    scan.failed = false;
    scan.advanced = false;

    for (const session of rows) {
      if (!session.outPath) continue;
      await scanSession(scan, session.id, session.cliSessionId, session.outPath);
    }
    if (scan.foreign.size) {
      console.warn(`[ash] 内置 Monitor 历史回填：task=${taskId} 的文件里出现了别的会话身份`
        + `（${[...scan.foreign].join(", ")}），已按文件归属采用`);
    }
    if (scan.truncated || scan.failed) {
      console.warn(`[ash] 内置 Monitor 历史回填这一轮没读完（task=${taskId}，`
        + `${scan.truncated ? "有文件读到了单次上限" : ""}${scan.truncated && scan.failed ? "，" : ""}`
        + `${scan.failed ? "有文件读失败" : ""}），游标已记下，下次打开面板继续往后读`);
    }

    // 有新内容才值得重新提交事实；没有也要往下走，因为死活要重新裁决。
    if (scan.advanced) added = await commitFound(taskId, foundOf(scan));
  } catch (e) {
    // 回填失败不该让面板打不开：这是补历史，不是主路径。但要留下线索，而且**部分成功的那些
    // 也要让别的页面看得到**——两个 publish 都在失败出口之后的话，已经提交的行要等下一次
    // 动作才会出现在其它页面上（第 4 轮审查不拦项 3）。
    console.warn(`[ash] 内置 Monitor 历史回填失败（task=${taskId}）:`, e);
    if (added) bus.publish({ type: "task.monitors", taskId });
    snapshots.delete(taskId); // 失败的快照不留，下次从头建
    return added;
  }

  try {
    if (await reconcileLiveness(taskId)) bus.publish({ type: "task.monitors", taskId });
  } catch (e) {
    console.warn(`[ash] 内置 Monitor 死活裁决失败（task=${taskId}）:`, e);
  }
  if (added) bus.publish({ type: "task.monitors", taskId });
  return added;
}

/** 这次插入撞的是唯一索引吗（= 别人刚补过同一条，幂等，不是错误）。 */
const isUniqueConflict = (e: unknown): boolean =>
  (e as { errcode?: number } | null)?.errcode === 2067
  || /UNIQUE constraint failed/i.test((e as Error | null)?.message ?? "");

type PriorRow = {
  id: string; nativeId: string | null; status: string;
  cliSessionId: string | null; sourceLifetime: string; startedAt: string;
  lifetimeEvidence: string | null; sourcePid: number | null;
};

/** 把扫出来的结果落库：缺的插进去，已有的按事实优先级补齐/纠正。 */
async function commitFound(taskId: string, items: Found[]): Promise<number> {
  if (!items.length) return 0;
  const existing = new Map((await db
    .select({
      id: monitors.id, nativeId: monitors.nativeId, status: monitors.status,
      cliSessionId: monitors.cliSessionId, sourceLifetime: monitors.sourceLifetime,
      startedAt: monitors.startedAt, lifetimeEvidence: monitors.lifetimeEvidence,
      sourcePid: monitors.sourcePid,
    })
    .from(monitors)
    .where(and(eq(monitors.taskId, taskId), eq(monitors.kind, "claude"))))
    .filter((r) => !!r.nativeId)
    .map((r) => [r.nativeId as string, r]));

  const probe = createLivenessProbe();
  let added = 0;
  let corrected = 0;

  for (const item of items) {
    // 没读到终态有两种可能，差别正好相反：那一轮的进程早就没了（该写 lost），还是它**现在
    // 还在盯着**（该写 running）。问来源，别猜。
    //
    // `staleRun` 是最强的那档证据：它所在的 run 文件后面还有更新的 run，那一代进程必然已经
    // 退出。没有它就只能退回「这条会话现在有活进程」，而那会被下一回合的新进程骗。
    const alive = item.status || item.staleRun
      ? false
      : await probe.sourceAlive({ cliSessionId: item.cliSessionId, taskId });
    const status = item.status ?? (alive ? "running" : "lost");
    const endedReason = item.endedReason
      ?? (item.status ? null : alive ? null : "历史记录里没有它的结局（那一轮的进程早已结束）");
    const prior = existing.get(item.nativeId);

    if (prior) {
      if (await mergeInto(prior, item, status, endedReason)) corrected += 1;
      continue;
    }
    const startedAt = item.startedAt || now();
    // **起点不可信就不编到期时刻。** 只有起手回执那条事件的时刻算真锚点（见 Found.startedAt）。
    const trusted = item.startedAtFrom === "receipt";
    const lifetime: MonitorLifetime = item.lifetime === "bounded" && !trusted ? "unknown" : item.lifetime;
    const rowId = id();
    try {
      await insertFound(rowId, taskId, item, status, endedReason, startedAt, lifetime, trusted);
      added += 1;
      existing.set(item.nativeId, {
        id: rowId, nativeId: item.nativeId, status, cliSessionId: item.cliSessionId,
        sourceLifetime: lifetime, startedAt, lifetimeEvidence: trusted ? "receipt" : null,
        sourcePid: item.staleRun ? 0 : null,
      });
    } catch (e) {
      if (!isUniqueConflict(e)) throw e; // 真写失败：往外抛，这一轮不算读完
    }
  }
  if (corrected) bus.publish({ type: "task.monitors", taskId });
  return added;
}

/** 插一行历史投影。只读投影：没有 pid、没有日志文件（见 shared/monitor.ts 的两种来源）。 */
async function insertFound(
  rowId: string, taskId: string, item: Found, status: string, endedReason: string | null,
  startedAt: string, lifetime: MonitorLifetime, trusted: boolean,
): Promise<void> {
  await db.insert(monitors).values({
    id: rowId,
    taskId,
    command: item.call.command,
    description: item.call.description,
    cwd: "",
    status,
    pid: null,
    pidStartedAt: null,
    logPath: "",
    offset: 0,
    events: 0,
    exitCode: null,
    startedAt,
    expiresAt: lifetime === "bounded" && item.expiresMs !== null
      ? new Date(Date.parse(startedAt) + item.expiresMs).toISOString()
      : startedAt,
    // 还在跑的没有结束时刻；结束了的用通知附近那条事件的时刻。都没有就留空——写 now()
    // （回填这一刻，可能是几天后）等于把读取时间冒充成来源完成时间。
    endedAt: status === "running" ? null : item.endedAt,
    endedReason,
    ownerUserId: null,
    kind: "claude",
    nativeId: item.nativeId,
    cliSessionId: item.cliSessionId,
    sourceLifetime: lifetime,
    lifetimeEvidence: trusted && lifetime !== "unknown" ? "receipt" : null,
    // 历史重建拿不到「起它的那一代进程」的 pid——`sessions` 那两列早被后续回合覆盖了。
    // 但**「那一代已经结束」这个结论是拿得到的**：它所在的 run 文件后面还有更新的 run。
    // 0 就是这个结论（见 db/schema.ts 的说明）；拿不到任何证据才留 null。
    sourcePid: item.staleRun ? 0 : null,
    sourcePidStartedAt: null,
  });
}

/**
 * 已有行：按来源事实补齐/纠正，**不是「已有就永不更新」**。
 *
 * 四件事各自独立判断：
 * - **会话归属**：`cli_session_id` 为空的存量行补上，否则开机清扫和流收尾都认不出它。
 * - **结局**：只纠正 ash 自己推断的 `running`/`lost`；来源说过的终态不碰。
 * - **期限**：只认起手回执，且只在起点可信时落到期时刻；同时写上证据列。
 * - **起点**：拿到可信锚点就把它改对（旧行那个可能是 tool_use 或文件时刻的占位值）。
 */
async function mergeInto(
  prior: PriorRow, item: Found, status: string, endedReason: string | null,
): Promise<boolean> {
  const patch: Record<string, unknown> = {};
  if (!prior.cliSessionId && item.cliSessionId) patch.cliSessionId = item.cliSessionId;
  // 代次结论也要补到存量行上，否则下面的死活裁决仍会被新进程骗。
  if (item.staleRun && prior.sourcePid === null) patch.sourcePid = 0;
  if (item.status && prior.status !== status && monitorStatusCorrectable(prior.status)) {
    patch.status = status;
    patch.endedAt = item.endedAt;
    patch.endedReason = endedReason;
  }
  // 期限：旧行可能写着一个由旧算法推出来的 bounded（`lifetime_evidence` 为空），那种也要被
  // 回执纠正——不能只升级 unknown（第 4 轮审查实测 legacyLifetimes）。
  const trusted = item.startedAtFrom === "receipt" && !!item.startedAt;
  if (prior.lifetimeEvidence !== "receipt" && item.lifetime !== "unknown") {
    if (item.lifetime === "bounded" && item.expiresMs !== null && trusted) {
      patch.sourceLifetime = "bounded";
      patch.startedAt = item.startedAt;
      patch.expiresAt = new Date(Date.parse(item.startedAt!) + item.expiresMs).toISOString();
      patch.lifetimeEvidence = "receipt";
    } else if (item.lifetime === "persistent") {
      patch.sourceLifetime = "persistent";
      patch.lifetimeEvidence = "receipt";
    }
  }
  if (!Object.keys(patch).length) return false;
  await db.update(monitors).set(patch).where(eq(monitors.id, prior.id));
  return true;
}

/**
 * 重新裁决这个任务已有投影行的死活，**与文件有没有新内容无关**。
 *
 * 两个方向都要纠正：
 * - 写着 `lost`、而起它的来源其实还活着 → 回到 `running`（上一次判错了）。
 * - 写着 `running`、而来源已经没了 → 落 `lost`。
 *
 * 为什么不能并进 `mergeInto`：那条路要求「这一轮扫到了这条 Monitor」。文件没有新内容时
 * （常态）根本不会走到它，而进程的死活随时在变（实测 existingLiveness 两个方向都卡住）。
 * 来源已经给过终态的行不在此列 —— 那是事实，不是推断。
 */
async function reconcileLiveness(taskId: string): Promise<boolean> {
  const rows = await db
    .select({
      id: monitors.id, status: monitors.status, cliSessionId: monitors.cliSessionId,
      taskId: monitors.taskId, sourcePid: monitors.sourcePid, sourcePidStartedAt: monitors.sourcePidStartedAt,
    })
    .from(monitors)
    .where(and(
      eq(monitors.taskId, taskId),
      eq(monitors.kind, "claude"),
      inArray(monitors.status, ["running", "lost"]),
    ));
  if (!rows.length) return false;

  const probe = createLivenessProbe();
  const revive: string[] = [];
  const bury: string[] = [];
  for (const row of rows) {
    const alive = await probe.sourceAlive(row);
    if (alive && row.status === "lost") revive.push(row.id);
    else if (!alive && row.status === "running") bury.push(row.id);
  }
  if (revive.length) {
    await db.update(monitors)
      .set({ status: "running", endedAt: null, endedReason: null })
      .where(and(inArray(monitors.id, revive), eq(monitors.status, "lost")));
  }
  if (bury.length) {
    await db.update(monitors)
      .set({ status: "lost", endedAt: now(), endedReason: "起它的那个智能体进程已经不在了" })
      .where(and(inArray(monitors.id, bury), eq(monitors.status, "running")));
  }
  return revive.length + bury.length > 0;
}
