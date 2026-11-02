// 创建协议里**身份与上膛**这一段:把完整身份写进那一行,并在同一条语句里证明「这次创建
// 此刻仍然该放行」。
//
// 从 monitor-create.ts 拆出来,它自成一件事:这几个函数回答的全是**放不放行**,而正路上
// 其余步骤回答的是「做不做得成」。两条不变量压在这里 ——
//
//  · **身份不全不许开工**(第 9 轮审查 F3):问不出代次就拒,别拿「看见它活着」当「证明有权
//    回收它」;
//  · 放行的判据必须是**一条语句**(第 9 轮审查 F1):分开读再判,读与判之间还能换轮。
//  · **「哪一次审查」也是放行条件的一位**(自由工作流审查第 1 轮问题 3):事后停掉撤不回一条
//    已经跑过的命令,所以过期创建根本不能开工。那一位怎么算见 `reviewGenerationFence`。
//
// 来由写在 monitor-create.ts 文件头与各函数自己的注释里。
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { isTaskRevoked } from "./claude-monitor-revoked.js";
import { db } from "./db/index.js";
import { monitors, regressionEvidence, tasks } from "./db/schema.js";
import { freeReviewEvidenceDir } from "./free-review-files.js";
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
 * 一条 `UPDATE … WHERE` 同时断言五件事(第 9 轮审查 F1 要的「CAS 或等价协议」):
 *  · 这一行还在、还是 running —— 没有被用户点停(`stopMonitor` 的第 ① 段先落「我停过」);
 *  · pid 还空着 —— 这一行还没被别人上过膛;
 *  · 发请求的那一轮**还是当前这一轮**(`tasks.active_turn_token` 没换);
 *  · 绑下来的那一次审查**还在那一轮上**(没收尾、没进下一轮);
 *  · 绑下来的那一次审查**还是同一次**(代次没被重跑换掉,见 `reviewGenerationFence`)。
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
      reviewGenerationFence(row),
    ));
  return Number((result as { rowsAffected?: number | bigint } | null)?.rowsAffected ?? 0) > 0;
}

/**
 * 放行条件里的**「还是同一次审查吗」**那一位(自由工作流审查第 1 轮问题 3)。
 *
 * 上一版的放行 SQL 只问到 run 的 `status/current_round`,而**同一轮会被用户重跑**:run 和轮次
 * 两样都原封不动,换掉的只有证据行的 `generation`。于是一条还在创建中的旧请求(完整进程身份
 * 已经拿到、放行 SQL 还没跑)会在重跑换完代次之后照样上膛 —— 实测 `rowsAffected=1`、
 * `startMonitor` 回 ok=true、那条旧命令真的写出了标记文件,随后才被重跑清理置成 stopped。
 * **事后停止撤不回一条已经执行的命令**,所以这一位必须和另外四位同在一条语句里。
 *
 * 为什么不能靠 `wake`/回合 token 兜:面板创建(external)压根没有回合 token,而「叫审查者」
 * 正是它允许的用法;创建与收旧又都串在同一条 `task:<id>` 队列上,旧请求可以持有队列、让重跑
 * 事务先提交、把旧清理排到自己后面 —— 生命周期锁管不到「命令开工许可」这一件事。
 *
 * **严格方向与 `isReviewSourceActive` 相反,这是故意的**:那一问答的是「要不要作废一个**已有
 * 结果**」,读不到代次就放行(宁可多送一条,别把真结果扣掉);这一问答的是「要不要让一条命令
 * **开工**」,说不清就不许开工 —— 两边的误判代价不对称。所以证据行此刻不在、或者代次记下来
 * 了却没记轮次(算不出证据目录),一律不放行。
 *
 * 目录由 `row.taskId` 算,跟创建时登记代次用的是同一个键(`monitorSourceBinding` 里
 * `reviewGenerationOf(task.id, …)`),所以两头按构造就对得上;**不在 SQL 里拼这个路径** ——
 * 分隔符在 win32 上不一样,拼出来的第二份公式在那台机器上永远匹配不到。
 */
function reviewGenerationFence(row: Row): SQL {
  if (!row.sourceReviewRun || !row.sourceReviewGeneration) return sql`1 = 1`;
  const directory = reviewEvidenceDirOf(row);
  if (!directory) return sql`1 = 0`;
  return sql`exists (select 1 from ${regressionEvidence}
    where ${regressionEvidence.directory} = ${directory}
      and ${regressionEvidence.generation} = ${row.sourceReviewGeneration})`;
}

/**
 * 这一行绑的那次审查,证据目录是哪一个 —— 代次那一位按它查(两处共用一份公式)。
 *
 * 算不出来(没记 run、或者记了代次却没记轮次)就是 null = **核不了**。`monitorSourceBinding`
 * 的 `bind()` 三位同进同出,所以正常不会出现;出现了只说明这一行的身份不全。
 */
function reviewEvidenceDirOf(row: Row): string | null {
  return row.sourceReviewRun && row.sourceReviewRound !== null
    ? freeReviewEvidenceDir(row.taskId, row.sourceReviewRun, row.sourceReviewRound)
    : null;
}

/**
 * **诊断用**:这一行记的代次此刻已经对不上了(或者压根核不了)。
 *
 * 放行闸比 `isReviewSourceActive` 严两格(理由见 `reviewGenerationFence`):证据行此刻不在、
 * 或者身份不全时,那一问会放行、这一闸不会。措辞得跟上,不然用户读到的是兜底那句「被别的
 * 写入改过了」—— 那句话虽然不假,却指不到真正的原因。
 */
async function reviewGenerationStale(row: Row): Promise<boolean> {
  if (!row.sourceReviewRun || !row.sourceReviewGeneration) return false;
  const directory = reviewEvidenceDirOf(row);
  if (!directory) return true;
  return (await db.select({ directory: regressionEvidence.directory }).from(regressionEvidence)
    .where(and(
      eq(regressionEvidence.directory, directory),
      eq(regressionEvidence.generation, row.sourceReviewGeneration),
    ))).length === 0;
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
    && !await isReviewSourceActive(fresh.sourceReviewRun, fresh.sourceReviewRound, fresh.sourceReviewGeneration)) {
    return REVIEW_SOURCE_GONE;
  }
  if (await reviewGenerationStale(fresh)) return REVIEW_SOURCE_GONE;
  return "创建还没完成，这条登记行被别的写入改过了（没有放行，那条命令没有开工）";
}
