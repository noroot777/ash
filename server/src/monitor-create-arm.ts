// 创建协议里**身份与上膛**这一段:把完整身份写进那一行,并在同一条语句里证明「这次创建
// 此刻仍然该放行」。
//
// 从 monitor-create.ts 拆出来,它自成一件事:这几个函数回答的全是**放不放行**,而正路上
// 其余步骤回答的是「做不做得成」。两条不变量压在这里 ——
//
//  · **身份不全不许开工**(第 9 轮审查 F3):问不出代次就拒,别拿「看见它活着」当「证明有权
//    回收它」;
//  · 放行的判据必须是**一条语句**(第 9 轮审查 F1):分开读再判,读与判之间还能换轮。
//
// 来由写在 monitor-create.ts 文件头与各函数自己的注释里。
import { and, eq, isNull, sql } from "drizzle-orm";
import { isTaskRevoked } from "./claude-monitor-revoked.js";
import { db } from "./db/index.js";
import { monitors, tasks } from "./db/schema.js";
import { CALLER_EXPIRED, isReviewSourceActive, REVIEW_SOURCE_GONE } from "./monitor-session.js";
import type { Row } from "./monitors.js";
import { inspectProcess } from "./proc.js";

const detail = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * pid 的**完整身份**:号 + 这一代的启动时刻。
 *
 * 查不出来时重试两次 —— ps(或 Windows 上那段 PowerShell)不可用通常只是一瞬。仍然查不出来
 * 就返回 null,调用方据此**拒绝这次创建**:带着一个只能证明存在的残缺身份放行,等于把
 * 「看见一个进程活着」当成「已证明有权回收它」(第 9 轮审查 F3,判据见 proc.ts 的
 * `unverifiable`)。
 */
export async function completeIdentity(pid: number): Promise<string | null> {
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
export async function armRow(row: Row, startedAt: string, token: string | null): Promise<boolean> {
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
export async function noteProcessClue(row: Row, startedAt: string | null): Promise<void> {
  try {
    await db.update(monitors)
      .set({ pid: row.pid, pidStartedAt: startedAt })
      .where(and(eq(monitors.id, row.id), isNull(monitors.pid)));
  } catch (e) {
    console.error(`[ash] 哨兵 ${row.id} 的 pid 线索写不进库（pid=${row.pid}）:`, detail(e));
  }
}

/** 上膛没改到行 —— 到底是哪一种。**只决定说哪句话**(见 `armRow`)。 */
export async function diagnoseArm(monitorId: string, taskId: string, token: string | null): Promise<string> {
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
