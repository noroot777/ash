// 停不掉的那个进程:**回收责任**。
//
// 「生命周期已撤销 ⇒ 不许再有它的资源在跑」这条不变量有两半(第 3 轮审查 F1):
// 不许再创建(资格闸,见 monitor-session.ts 的 `isTaskRevoked` 那一处),以及
// **现有资源必须被回收、或者持久留下回收责任**。这个文件是后半。
//
// 为什么必须持久:删除/归档这条路上,停止没能确认之后紧接着就是删行批次,`monitors` 那一行
// (连带 pid + 启动时刻)一起消失 —— 进程还在后台烧着,而库里再没有任何线索指向它,重启的
// 接回也认领不回来。之前这里只有一行 `console.error`,也就是「谁也不知道这件事」。
//
// 清扫是幂等的:进程确认不在了(或者那个 pid 已经是别人了)就销账,还在就再杀一次。
import { eq } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { monitorReclaimDebts } from "./db/schema.js";
import { killByPid } from "./executors/spawn.js";
import { isSameProcess } from "./proc.js";
import { now } from "./util.js";

/** 进程内的重试梯子。跟 claude 投影那边的补偿清理同一个形状(claude-monitor-revoked.ts)。 */
const LADDER_MS = [1_000, 5_000, 20_000];
const pending = new Set<string>();

/**
 * 记一笔:这个进程该停,但这一刀没落下去。
 *
 * 调用点在回收层里每条「停止没能确认」的分支上。记完**立刻**推一次梯子 —— 多数失败是
 * 瞬时的(库忙、信号被丢),一秒后再杀一次就成了;真顽固的留给启动期清扫。
 */
export async function noteReclaimDebt(debt: {
  monitorId: string; taskId: string; pid: number; pidStartedAt: string | null;
  command: string; reason: string; error: unknown;
}): Promise<void> {
  if (dbClient.closed) return;
  const detail = debt.error instanceof Error ? debt.error.message : String(debt.error ?? "");
  const row = {
    monitorId: debt.monitorId, taskId: debt.taskId, pid: debt.pid,
    pidStartedAt: debt.pidStartedAt, command: debt.command, reason: debt.reason,
    lastError: detail || null, attempts: 0, createdAt: now(), lastAttemptAt: null,
  };
  try {
    // 同一条反复欠账只占一行:覆盖的是「最近一次为什么没停掉」,attempts 由清扫侧累加。
    await db.insert(monitorReclaimDebts).values(row)
      .onConflictDoUpdate({ target: monitorReclaimDebts.monitorId, set: { lastError: row.lastError, reason: row.reason } });
  } catch (error) {
    // 连责任都记不下来:那就只剩日志了,但至少把 pid 打全,人工还能收。
    console.error(`[ash] 回收责任落库失败 monitor=${debt.monitorId} pid=${debt.pid}:`, error);
    return;
  }
  scheduleRetry(debt.monitorId);
}

function scheduleRetry(monitorId: string, step = 0): void {
  if (step >= LADDER_MS.length || pending.has(monitorId)) return;
  pending.add(monitorId);
  const timer = setTimeout(() => {
    pending.delete(monitorId);
    void settleDebt(monitorId).then((done) => {
      if (!done) scheduleRetry(monitorId, step + 1);
    }).catch(() => scheduleRetry(monitorId, step + 1));
  }, LADDER_MS[step]);
  // 不许因为一笔欠账把进程吊着不退(测试套件逐条跑完就结束)。
  timer.unref?.();
}

/** 推一笔:进程真没了 ⇒ 销账返回 true;还活着 ⇒ 再杀一次、记一次尝试,返回 false。 */
async function settleDebt(monitorId: string): Promise<boolean> {
  if (dbClient.closed) return false;
  const debt = (await db.select().from(monitorReclaimDebts)
    .where(eq(monitorReclaimDebts.monitorId, monitorId))).at(0);
  if (!debt) return true; // 别人已经销了
  // pid 复用:对不上就**不许杀** —— 那是别人的进程。对不上同时说明当初那个已经退了,销账。
  if (!isSameProcess(debt.pid, debt.pidStartedAt)) {
    await db.delete(monitorReclaimDebts).where(eq(monitorReclaimDebts.monitorId, monitorId));
    return true;
  }
  killByPid(debt.pid);
  if (!isSameProcess(debt.pid, debt.pidStartedAt)) {
    await db.delete(monitorReclaimDebts).where(eq(monitorReclaimDebts.monitorId, monitorId));
    console.error(`[ash] 回收责任已销账 monitor=${monitorId} pid=${debt.pid}(补杀成功)`);
    return true;
  }
  await db.update(monitorReclaimDebts)
    .set({ attempts: debt.attempts + 1, lastAttemptAt: now() })
    .where(eq(monitorReclaimDebts.monitorId, monitorId));
  return false;
}

/**
 * 启动期清扫:上一个 server 没能收掉的那几个进程,**现在就是最后一次机会**。
 *
 * 排在 `reattachMonitors` 之后:接回那一步只认 `monitors` 里还在的行,而这张表里的行多半
 * 连任务都没了 —— 两件事互不覆盖。
 */
export async function sweepMonitorReclaimDebts(): Promise<{ settled: number; left: number }> {
  if (dbClient.closed) return { settled: 0, left: 0 };
  const rows = await db.select().from(monitorReclaimDebts);
  let settled = 0;
  for (const row of rows) {
    try {
      if (await settleDebt(row.monitorId)) settled += 1;
      else {
        console.error(
          `[ash] 开机仍有收不掉的哨兵进程 pid=${row.pid} monitor=${row.monitorId} task=${row.taskId}`
          + ` 命令：${row.command}（${row.reason}）`,
        );
        scheduleRetry(row.monitorId);
      }
    } catch (error) {
      console.error(`[ash] 清扫回收责任失败 monitor=${row.monitorId}:`, error);
    }
  }
  return { settled, left: rows.length - settled };
}
