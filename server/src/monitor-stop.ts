// 停一条哨兵。**从 monitors.ts 拆出来的那一段**(全局约定:单文件不超过 700 行)——
// 它自成一块职责:两段式的取消协议、跟创建共用的那条资源队列、以及停完之后的责任补收。
// 运行时、收尾、取证那三层仍在各自的文件里,这里只按它们的公开判据组合。
import { and, eq, isNull } from "drizzle-orm";
import type { TaskMonitor } from "@ash/shared/monitor";
import { db } from "./db/index.js";
import { monitors } from "./db/schema.js";
import { reclaimMonitorProcess, settleReclaim } from "./monitor-reclaim-debts.js";
import { reclaimState } from "./monitor-reclaim-evidence.js";
import { detachMonitor, finish, serialize, toTaskMonitor } from "./monitors.js";
import { now } from "./util.js";

export type StopMonitorResult =
  | { ok: true; monitor: TaskMonitor }
  | { ok: false; status: 404 | 409; error: string };

/**
 * 停一个哨兵。
 *
 * claude 内置 Monitor 的投影行**一律拒绝**而不是静默忽略：它的进程在 agent 自己的进程树
 * 里，`TaskStop` 是 claude 进程内的工具，ash 没有任何手柄够得着。假装停掉（把状态改成
 * stopped 就返回）比报错坏得多——那个进程还在那边跑着、还会继续唤醒任务，而界面上写着
 * 「已停止」，用户再也不会回头看它。前端据此根本不给 claude 那种卡渲染停止按钮，这里是
 * 第二道闸（API 直调、旧前端）。
 */
export async function stopMonitorChecked(monitorId: string, reason = "被停掉了"): Promise<StopMonitorResult> {
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
  if (!row) return { ok: false, status: 404, error: "哨兵不存在" };
  if (row.kind === "claude") {
    return {
      ok: false,
      status: 409,
      error: "这是 claude 自己起的 Monitor，ash 只能看不能停——它的进程在智能体的进程树里。要停只能让智能体自己 TaskStop，或者停掉整个任务。",
    };
  }
  const monitor = await stopMonitor(monitorId, reason);
  return monitor ? { ok: true, monitor } : { ok: false, status: 404, error: "哨兵不存在" };
}

/**
 * 停一条哨兵。**它和创建共用 `task:<id>` 那条队列** —— 「停止」和「创建」是同一份资源所有权
 * 协议的两端,不排同一条队就会各自看到半成品:
 *
 * 上一版这里完全不参加那条队列,于是一次点停可以恰好落在「身份已登记、pid 还没回填」那一瞬:
 * 它读到 pid=null 的运行行 → 回收层按「没有待收资源」放过 → 写成 stopped 并**成功返回**,
 * 而创建随后照旧放行,命令这才开工;再点停时状态已经不是 running,`finish` 第一行就返回 ——
 * 页面写着已停止、进程活着、而且再也停不掉(第 8 轮审查 F1 实测 `aliveAfterSecondStop=true`)。
 *
 * 所以这里是两段:
 *  ① 读到一条**pid 还空着的运行行** = 创建正在半空中。先把「我停过」落盘 —— 创建方在放行
 *    之前会重读这一行(monitor-create.ts 的 ④),读到非 running 就不放行,命令一个字都不跑。
 *  ② 再进那条队列。拿到的是创建已经收口之后的终局,按它该怎么停就怎么停。
 */
export async function stopMonitor(monitorId: string, reason = "被停掉了"): Promise<TaskMonitor | null> {
  const before = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
  if (!before) return null;
  if (before.kind === "claude") return toTaskMonitor(before);
  // ① 创建还在半空中:**先落「我停过」**。条件更新(仍是 running 且 pid 仍空)避免跟同一瞬
  //    完成的创建互相覆盖 —— 回填成功的那一侧会让这条更新一行都不动,于是走 ② 的正常停止。
  if (before.status === "running" && before.pid === null) {
    const marked = await db
      .update(monitors)
      .set({ status: "stopped", endedAt: now(), endedReason: reason })
      .where(and(eq(monitors.id, monitorId), eq(monitors.status, "running"), isNull(monitors.pid)));
    // 标记落上了 ⇒ 这一行从此是终态,**运行时要跟着撤**:pid 还空着的行现在也可能挂着 tail
    // 和期限(见 monitor-reattach 的 pending 分支)。没落上说明同一瞬创建收口了,那条路由
    // 下面的 ② 正常处理 —— 这时撤运行时就是把一条还在盯的哨兵弄瞎。
    if (Number((marked as { rowsAffected?: number | bigint } | null)?.rowsAffected ?? 0) > 0) {
      await detachMonitor(monitorId);
    }
  }
  // ② 进创建那条队列。**不排在队首插队**:创建只差几毫秒就收口,等它比跟它抢更便宜也更可证。
  return serialize(`task:${before.taskId}`, async () => {
    const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
    if (!row) return toTaskMonitor(before);
    if (row.status === "running") {
      // 用户/agent 主动停的不回推收尾事件：他就是为了不再被它叫醒才点的停。但已经攒在缓冲里
      // 的行要照常推完——那是已经发生的事实，而且任务还活着，收得下。
      await finish(monitorId, "stopped", reason, null, { notify: false });
      const after = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
      return toTaskMonitor(after ?? row);
    }
    // 已经不是运行态了。**但「卡片上写着停了」不等于那个进程真的没了**:win32 那一侧没有
    // 放行闸(见 monitor-spawn.ts),① 的取消标记落下时命令可能已经开工。所以这里按**资源
    // 责任**再核一遍而不是看状态就返回 —— 这正是前几轮反复钉的那条判据。
    // 追空的那一档这里什么都不做:没有落点可打,而**身份还在这一行上**(命令、pid、记号),
    // 没有任何东西正在消失。留档发生在身份真要被销毁的那一刻 —— 删除/归档走的
    // `accountForLiveProcesses`(第 13 轮审查 F1-B,见 monitor-reclaim.ts)。
    // **pid 还空着的那一行也要走这一趟**(第 19 轮审查 F2):那是创建意图行(身份先落库、进程
    // 后起、pid 回填),它的结局恰恰最没确认 —— 判据交给 `reclaimMonitorProcess`,它会先问
    // 一遍认领、再按档位决定记责任还是收档,真的没有落点时才返回 `closed`。
    if (row.pid === null || reclaimState(row.pid, row.pidStartedAt, row) !== "traceless") {
      const outcome = await reclaimMonitorProcess(row, `${reason}（创建期取消后补收）`);
      if (await settleReclaim(outcome) === "unaccounted") {
        console.error(`[ash] 创建期取消后补收:既没确认退出、责任也没落库 monitor=${monitorId} pid=${row.pid}`);
      }
    }
    return toTaskMonitor(row);
  });
}
