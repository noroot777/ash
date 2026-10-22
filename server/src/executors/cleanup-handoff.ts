// **责任交不出去的那一段路** —— 从「清理这一刻判出还欠着谁」到「它真的落进库里」之间。
//
// 为什么单独一个文件:它跟三层击杀、跟取证判定都没有共享状态,只跟持久层打交道,而它自己
// 得在**持久层压根加载不起来**的时候还有地方站(`import("./cleanup-debt.js")` 抛出那一档)。
// 原来住在 kill.ts 里,那份文件已经顶到单文件 700 行的约定上限。
//
// 两层待投清单,各管各的一段,别混:
//  · 这里这一份 —— **交接层自己没加载起来**(几乎只会是数据库初始化那一侧出了事)⇒ 留在
//    进程内存里定时重试;
//  · `cleanup-debt.ts` 自己那一份(`flushPendingCleanupNotes`)—— 层加载起来了、**落库那一句
//    失败**。
import { joinOpen } from "./cleanup-result.js";
// 只借类型:持久层按需加载(它拉起整个 db 层),静态依赖会让「层加载失败」这一档压根不存在。
import type { CleanupDebtInput } from "./cleanup-debt.js";

/**
 * 把这一笔责任交给持久层。**连交接层自己都加载不起来时也得留个接手的**(第 3 轮审查 F2)。
 *
 * 上一版这里 `catch` 到就打一条日志、返回 `failed` 收场:那一笔既没进库,也不在任何人手上,
 * 后面哪一次清扫都不会再想起它。按需加载失败几乎只会是数据库初始化那一侧出了事,而那恰恰
 * 是「等一会儿再试就好了」的那种 —— 所以这里留一份进程内的待交清单,定时重试。
 * (落库本身失败那一档由 `cleanup-debt.ts` 自己的待投清单接着扛,两边各管自己那一段。)
 */
export async function handOffCleanupDebt(
  input: CleanupDebtInput,
): Promise<"noted" | "untrackable" | "failed"> {
  try {
    const layer = await import("./cleanup-debt.js");
    return await layer.noteCleanupDebt(input);
  } catch (error) {
    console.error("[ash] 清理责任这一层加载失败,这一笔先留在内存里等重试:", error);
    keepUndelivered(input);
    scheduleRedelivery();
    return "failed";
  }
}

/**
 * 连持久层都没加载起来的那几笔,**按这一次运行去重**(第 4 轮审查 N3)。
 *
 * 上一版是个数组、一笔一笔 `push`:同一次运行反复交不出去时会在清单上堆好几份旧结论,
 * 补交按入列顺序一个个投,于是**旧的那一版最后落库、盖掉新的**。键按同一套线索算
 * (记号优先、退回运行专属文件路径,同 `debtKey`),所以同一次运行只会占一格、留最新那版。
 */
const undelivered = new Map<string, CleanupDebtInput>();
let redeliveryTimer: ReturnType<typeof setTimeout> | null = null;
const REDELIVERY_DELAY_MS = 30_000;

/** 只为去重算的键 —— 真正落库用哪个键由 `cleanup-debt.ts` 的 `debtKey` 说。 */
const undeliveredKey = (input: CleanupDebtInput): string =>
  input.unitToken || input.outPath || input.trackPath || "no-clue";

function keepUndelivered(input: CleanupDebtInput): void {
  const key = undeliveredKey(input);
  // 叙述留最新那版(见上面那段),**点过的名两份并起来**:后一份输入更弱(这一刻取证失败、
  // 名单是空的)时,按键覆盖会把前一份里那个已知的活后代整个丢掉(第 9 轮审查 F1-B 的
  // 同类位置)。要从名单上消失只能靠退出证据。
  const held = undelivered.get(key);
  undelivered.set(key, held
    ? { ...input, open: joinOpen(held.open ?? [], input.open ?? []) }
    : input);
}

function scheduleRedelivery(): void {
  if (redeliveryTimer || !undelivered.size) return;
  redeliveryTimer = setTimeout(() => {
    redeliveryTimer = null;
    const batch = [...undelivered.values()];
    undelivered.clear();
    void (async () => { for (const one of batch) await handOffCleanupDebt(one); })();
  }, REDELIVERY_DELAY_MS);
  // 不拿住事件循环:这件事不该让一个本来可以退出的进程多活着。
  (redeliveryTimer as { unref?: () => void }).unref?.();
}

/** 披露用:这一刻有几笔责任连持久层都还没交出去。 */
export const undeliveredCleanupDebtCount = (): number => undelivered.size;
