// **死活裁决**:已有投影行的 running/lost 这一轮该不该翻过来。
//
// 从 `claude-monitor-backfill.ts` 拆出来的理由是单文件 700 行上限(全局约定),判据没变:
// 它和回填那一轮是两件事 —— 回填问「文件里有什么新事实」,这里问「起这些行的来源还在不在」,
// 后者**与文件有没有新内容无关**(所以它在扫描之外、按每一轮的 run 文件清单现算)。
//
// 调用点只有一个:`runBackfill` 的收尾,结果并进那一轮的恢复责任(失败 ⇒ liveness-failed)。
import { and, eq, inArray } from "drizzle-orm";
import { createLivenessProbe } from "./claude-monitor-liveness.js";
import { db } from "./db/index.js";
import { monitors } from "./db/schema.js";
import { now } from "./util.js";

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
export async function reconcileLiveness(
  taskId: string,
  /** 这一轮看到的 run 文件（见 TaskScan.runFiles）。代次结论由它和行上的 `source_run` 现算。 */
  runFiles: { all: Set<string>; latest: Set<string> },
): Promise<boolean> {
  const rows = await db
    .select({
      id: monitors.id, status: monitors.status, cliSessionId: monitors.cliSessionId,
      taskId: monitors.taskId, sourcePid: monitors.sourcePid, sourcePidStartedAt: monitors.sourcePidStartedAt,
      sourceRun: monitors.sourceRun,
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
  /** 这一轮新判明「那一代 run 已经结束」的行：结论要落到列上，别每轮重算（也给开机清扫用）。 */
  const stale: string[] = [];
  for (const row of rows) {
    // ── 代次：**认文件，不认内存** ───────────────────────────────────────────────
    //
    // 这一行起在哪个 run 文件里是记在列上的（`source_run`），而「这条会话最新的 run 是哪个」
    // 这一轮刚列过。两样一比就知道「后来又起过新一轮没有」——不需要 `found` 还在内存里。
    //
    // 为什么非这样不可：配对状态被内存上限挤掉之后，`found` 是空的，代次翻转无从算起；而新
    // 回合会先创建一个**空的** run 文件，于是旧监听会被「这条会话现在有活进程」证明成「还在
    // 盯着」——拿下一代人的凭据给上一代续命（第 10 轮审查用生产服务 + 真页面实测）。
    //
    // 只在「这一行的 run 文件这一轮确实列到了」时才下这个结论：列不到（文件被删、目录换了）
    // 说明我们没有权威清单，那就不猜，退回下面按 pid / 会话判。
    const outdated = !!row.sourceRun && runFiles.all.has(row.sourceRun) && !runFiles.latest.has(row.sourceRun);
    if (outdated && row.sourcePid !== 0) stale.push(row.id);
    const alive = outdated ? false : await probe.sourceAlive(row);
    if (alive && row.status === "lost") revive.push(row.id);
    else if (!alive && row.status === "running") bury.push(row.id);
  }
  if (stale.length) {
    // 0 不是缺省值而是明确结论：「起它的那一代 run 之后又起过新的 run」（见 db/schema.ts）。
    await db.update(monitors).set({ sourcePid: 0 }).where(inArray(monitors.id, stale));
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
  return revive.length + bury.length + stale.length > 0;
}
