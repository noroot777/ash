/**
 * **监督交接:让「库里还是运行态就必须有人盯」这条不变量活过一次失败的库操作**(第 24 轮审查 F1)。
 *
 * 收尾分三步:算结论(读日志、问回收)、把终态**落盘**、撤运行时。撤必须排在读日志之前
 * (自己那条 tail 不停下来就会边收尾边继续推),所以中间「监督已撤、终态未落」是真实的一瞬。
 * 上一轮在两条收尾路的 `finally` 里补了一次重读接回 —— 但那一次重读**用的是同一个库**:
 * 审查实测在真实到期前后注入约 700ms 的监听查询不可读,到期那次读失败、`finally` 那次也
 * 失败,而那时的兜底只打一行日志。故障过去之后行留在 `running`、监督一样也没有,命令照旧
 * 在跑、结果照旧写在磁盘上,却再也没有人把它读出去,期限也再没人算 —— 一次 700ms 的抖动
 * 换来永久失联。
 *
 * 所以「在 `finally` 里调用过恢复函数」不等于「监督已经交回」。这一层要的是**独立可重试的
 * 接管者**:每次只做一趟「把内存调到跟库一致」,做不成就自己排下一跳,**永不耗尽**(最后
 * 一档停在三分钟一问),直到读到已经落定的终态或者监督重新装好为止。
 *
 * 不变量是**两面**的,所以这一趟两边都调:
 *  · 库里还是运行态(且是 ash 自己起的)⇒ `attach` 回去(它幂等,还会补装缺的那一根探活);
 *  · 库里已经是终态、或者行已经不在了 ⇒ **不许还有人盯**。并发收尾会制造这一面:两笔收尾
 *    先后进来,第一笔落终态失败、`finally` 又挂回一个新运行时,第二笔随后写成 stopped ——
 *    那条已经停掉的行还占着文件句柄、还在算自己的期限(第 24 轮审查 N1 实测)。
 *
 * 为什么**不**把「撤运行时」挪到落盘之后就完事:那样这一瞬是没有的,但读日志就得在 tail
 * 还活着的时候做,最后几行会被自己的 tail 和这一趟收尾同时读走(谁先推完全看调度)。保留
 * 现在的顺序 + 一个会重试的接管者,比换一个更难证的顺序便宜。
 */
import { eq } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { monitors } from "./db/schema.js";
import { attach, serialize, supervisionOf, teardownRuntimeLocked } from "./monitors.js";

/**
 * 重试间隔:前几跳密(这类故障多半是一瞬),之后退到三分钟一问。**最后一档不是终点** ——
 * 它会一直按三分钟续约。耗尽等于把「暂时读不到」当成「等下一次启动吧」,而那正是审查
 * 实测到的失联现场。
 */
const HANDOVER_LADDER_MS = [200, 1_000, 5_000, 20_000, 60_000, 180_000];
const retries = new Map<string, { timer: NodeJS.Timeout; step: number }>();

/** 这一趟的结论:交接完了(库里是终态/行没了)、监督装好了、还是排了下一跳。 */
export type HandoverOutcome = "settled" | "supervised" | "retrying";

function scheduleHandover(monitorId: string, step: number): void {
  const capped = Math.min(step, HANDOVER_LADDER_MS.length - 1);
  const timer = setTimeout(() => { void ensureSupervised(monitorId); }, HANDOVER_LADDER_MS[capped]);
  // unref:它不许拖住进程退出。关库之后醒过来的那一跳自己会判出 `settled`。
  (timer as { unref?: () => void }).unref?.();
  retries.set(monitorId, { timer, step: capped });
}

/** 把内存调到跟库一致。**调用方保证已经在 `serialize(monitorId)` 里**。 */
async function reconcile(monitorId: string, step: number): Promise<HandoverOutcome> {
  try {
    const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
    // claude 的投影行没有自己的进程(进程在 agent 的进程树里),这一层没有它的事 —— 判据
    // 跟 `reattachMonitors` 那一侧同口径。
    if (!row || row.status !== "running" || row.kind !== "ash") {
      if (supervisionOf(monitorId).watching) {
        console.error(`[ash] 终态已经落定却还有人在盯,撤掉 monitor=${monitorId}（${row?.status ?? "行已不在"}）`);
        await teardownRuntimeLocked(monitorId);
      }
      return "settled";
    }
    attach(row);
    // `attach` 是幂等的,但「调过它」仍然不等于「装上了」:正在收尾的那一瞬它会原样返回。
    // 所以这里按**能力视图**复核,判不出装好就按失败排下一跳。
    if (!supervisionOf(monitorId).watching) throw new Error("attach 之后这一行仍然没有运行时");
    return "supervised";
  } catch (e) {
    console.error(
      `[ash] 把监督交回去这一趟失败了 monitor=${monitorId}（第 ${step + 1} 次，`
      + `${HANDOVER_LADDER_MS[Math.min(step, HANDOVER_LADDER_MS.length - 1)]}ms 后再来）:`, e,
    );
    scheduleHandover(monitorId, step);
    return "retrying";
  }
}

/**
 * **收尾交接的那一趟**:两条收尾路(`finish`/`finishOffline`)的 `finally` 和恢复梯子的 catch
 * 都调它,失败时由它自己排重试 —— 调用方不需要、也不应该自己判「要不要再来一次」。
 *
 * `holdingChain`:调用方已经跑在 `serialize(monitorId)` 上(`finishOffline` 整段都在那条队列
 * 里)。其余调用方走这里的 `serialize` —— 读、`attach`、撤运行时**排在这条哨兵自己的队列上**,
 * 于是并发的两笔收尾各自那一趟是有序的,不会出现「它读到 running、它落了终态」互相错开。
 */
export async function ensureSupervised(
  monitorId: string, opts: { holdingChain?: boolean } = {},
): Promise<HandoverOutcome> {
  const pending = retries.get(monitorId);
  if (pending) { clearTimeout(pending.timer); retries.delete(monitorId); }
  const step = pending ? pending.step + 1 : 0;
  // 关库了就没有「调到跟库一致」这回事:进程在退,运行时跟着进程走。
  if (dbClient.closed) return "settled";
  return opts.holdingChain ? reconcile(monitorId, step) : serialize(monitorId, () => reconcile(monitorId, step));
}

/** 排着的下一跳(给回归看的:失败之后到底有没有人接着管)。 */
export const pendingSupervisionHandovers = (): string[] => [...retries.keys()];

/** 撤掉排着的重试:`monitorId` 省略就是全部(关库前、测试 teardown 用)。 */
export function stopSupervisionHandover(monitorId?: string): void {
  if (monitorId === undefined) {
    for (const [, r] of retries) clearTimeout(r.timer);
    retries.clear();
    return;
  }
  const pending = retries.get(monitorId);
  if (!pending) return;
  clearTimeout(pending.timer);
  retries.delete(monitorId);
}
