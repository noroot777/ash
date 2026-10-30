// 普通回合起跑时的 ash MCP 提示 —— **只提示、不拦，也不让起跑等它**。
//
// 为什么普通回合不拦，见 `ash-mcp-launch-gate.ts` 文件头：那是用户自己派的活，产物不靠交卷
// 也留得下；问不了 CLI 的机器上判据只是读配置推断，拿推断拦掉用户亲手点的活不值。可一声
// 不吭也不行：缺了 ash MCP，这一轮无论干得多好都调不了 complete_task，跑完必然按「没交卷」
// 记未完成，而用户只看得到一句没有原因的失败（原任务第 1 轮审查第 3 条）。所以起跑同时在
// 后台问一次，确定没有就在时间线上先说一句，用户可以当场停掉去修，而不是等它跑完。
//
// 三条约束：
//  · **不进起跑的关键路径**：`void` 出去，起跑一个毫秒都不等它（预检最坏要等二十来秒，
//    Windows 上一问就要四五秒）。
//  · **同一个上下文十分钟内只问一次**：普通回合起得很频繁，每一轮都起一遍 CLI 子进程问
//    不值；登记这种东西也不会每分钟都变。
//  · **同一条任务同一个执行器、同一档结论只说一次**，档变了（「看着起不来」→「确定没有」或
//    反过来）就重说，查出来又通了才清账：缺登记的机器上每一轮都说同一句话就是刷屏，可只按
//    「说过没有」记账的话，先说过一句软的，后来确定没有时那句硬的就被吞了（第 1 轮审查第 2 条）。
//  · **记账有上限**：过期的缓存条目随手清，说过的记录超过上限就丢最旧的 —— 常驻进程里
//    任务和目录只增不减，不能让这两张表跟着一直长。
import { ashMcpReachability, type AshMcpReach } from "./ash-mcp-reachability.js";
import { appendTaskTimeline } from "./task-timeline.js";

/** 起跑提示这一档的缓存寿命。 */
const CACHE_MS = 10 * 60_000;
/** 「说过了」最多记多少条。超了丢最旧的：顶多让很久以前说过的那条任务再多说一次。 */
const TOLD_MAX = 2000;

type Query = {
  taskId: string;
  agentType: string;
  executorId: string | null;
  ownerUserId: string | null;
  /** 这一轮**真正**跑在的目录（调用方已经解析完了，不用再凑超集）。 */
  cwd: string;
  /**
   * 这一轮的会话行。提示写进**这一条**的时间线，所以调用方要在会话行落库之后再调：之前调的话，
   * fresh run 那条路上提示会在会话行出现之前就查完（读配置那一档只要几毫秒），无处可写。
   */
  sessionId: string;
};

const cache = new Map<string, { at: number; reach: Promise<AshMcpReach> }>();
/** 任务×执行器 → 上次说的是哪一档。Map 按插入顺序迭代，所以第一个键就是最旧的。 */
const told = new Map<string, "unreachable" | "warning">();

const contextKey = (q: Query) => JSON.stringify([q.ownerUserId, q.agentType, q.executorId, q.cwd]);

function cachedReach(q: Query): Promise<AshMcpReach> {
  const key = contextKey(q);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.reach;
  for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k);
  const reach = ashMcpReachability({
    ownerUserId: q.ownerUserId,
    agentType: q.agentType,
    executorId: q.executorId,
    cwdCandidates: [q.cwd],
  });
  cache.set(key, { at: now, reach });
  // 查挂了就别把这个失败缓存十分钟。
  reach.catch(() => { if (cache.get(key)?.reach === reach) cache.delete(key); });
  return reach;
}

/** 起跑时调一次。返回的 Promise 只给测试等；生产代码 `void` 掉。 */
export async function hintAshMcpForTurn(q: Query): Promise<void> {
  // 宽松完成协议（ASH_LAX_DONE，见 settle-status.ts 的 STRICT_DONE_PROTOCOL）就是给「agent
  // 够不着 ash MCP」的环境准备的：那里本来就不靠交卷，这句提示只会是噪音。不 import 那个常量，
  // 是不想让起跑路径为一句提示多背一份 settle-status 的依赖。
  if (process.env.ASH_LAX_DONE) return;
  const toldKey = JSON.stringify([q.taskId, q.agentType, q.executorId]);
  try {
    const reach = await cachedReach(q);
    const text = !reach.reachable
      ? `起跑预检提示：这一轮的 agent 多半交不了卷 —— complete_task / ask_question / pause_task 这些都是 ash MCP 的工具，`
        + `够不着的话这一轮干得再好也只能按「没交卷」记未完成。${reach.problem}`
        + "（只是提示，这一轮照常在跑；接好之后点重试会从中断处接着做。）"
      : reach.warning
        ? `起跑预检提示：${reach.warning}`
        : null;
    if (!text) { told.delete(toldKey); return; }
    const tier = reach.reachable ? "warning" : "unreachable";
    if (told.get(toldKey) === tier) return;
    told.delete(toldKey);
    told.set(toldKey, tier);
    if (told.size > TOLD_MAX) told.delete(told.keys().next().value!);
    // 没写进去就不算说过，下一轮还说。
    if (!(await appendTaskTimeline(q.taskId, text, { sessionId: q.sessionId }))) told.delete(toldKey);
  } catch (error) {
    console.error(`[ash] hintAshMcpForTurn(${q.taskId}) failed:`, error);
  }
}

/** 测试用：清掉缓存和「说过了」的记账。 */
export function resetAshMcpTurnHints(): void {
  cache.clear();
  told.clear();
}
